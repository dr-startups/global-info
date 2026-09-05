/**
 * Выбор персоны субъекта до первой траты (шаг 0032).
 *
 * Здесь живут все ответы этого вопроса и больше нигде не повторяются:
 * нормализация входа субъекта и его хеш, сборка панели различимых персон,
 * запись строки и решения по ней, предикат ворот.
 *
 * Панель отвечает «про кого мы собираем, пока ничего не потрачено». Рядом в
 * продукте живёт `SubjectIdentityProfile` — он отвечает «этот собранный
 * материал про нашего человека?» и работает **после** сбора. Связывать их
 * автоматически нельзя: у вопроса «кто тёзка» станет два владельца, и первое
 * же расхождение будет молчаливым.
 *
 * Выбор карточки санкционного списка здесь — ответ на вопрос «про кого
 * собирать», а не подтверждение комплаенс-совпадения: совпадения по-прежнему
 * рождает скрининг прогона и отдаёт аналитику как `PENDING`. Поэтому срез
 * зовёт провайдера напрямую и находок не создаёт.
 */

import { createHash } from "node:crypto";
import { loadCaseSubject, type CaseSubjectInfo } from "../agents/mock/mock-utils";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors";
import { providerConfig } from "../providers/config";
import {
  subjectTerms,
  wikipediaProvider,
  type WikipediaNamesakeResult,
} from "../providers/wikipedia-provider";
import {
  serperOrganicWithExtras,
  type SerperSurfaceBatchResult,
} from "../providers/serper-surfaces";
import type { ProviderRunResult, SearchProviderRequest } from "../providers/types";
import { yandexSearchProvider } from "../providers/yandex-search-provider";
import { hasCyrillic, type OrionRegionCode } from "../search-surfaces/orion-query-plan";
import { openSanctionsProvider } from "../compliance-providers/open-sanctions-provider";
import { RISK_TYPE_LABEL_RU } from "../compliance-providers/open-sanctions-mapping";
import type {
  ComplianceScreeningRequest,
  ComplianceScreeningResult,
} from "../compliance-providers/types";
import { prisma } from "@/server/prisma/client";
import type { PersonaDecisionRecord } from "../orion-golden/deck-sections/scoped-input";
import {
  hasStrongSubjectAnchor,
  hasSubjectAnchors,
  type SubjectAnchors,
} from "../orion-golden/analytics/subject-anchors";

// Ворота, кабинет и решение спрашивают о силе признака одну функцию.
export { hasStrongSubjectAnchor };
import { checkAnchorsInProbe, type AnchorProbeResult } from "./persona-anchor-probe";
import { loadCaseSubjectIdentityProfile } from "./subject-profile-admin";

// ---------------------------------------------------------------------------
// Настройки среза — константы модуля, а не переменные окружения и не настройки:
// оператор их не выбирает.
// ---------------------------------------------------------------------------

/**
 * Общий предел ожидания сборки панели.
 *
 * Считать его по таймаутам провайдеров нельзя: у Википедии восемь секунд на
 * вызов, две повторные попытки и пауза между вызовами — одиннадцать запросов
 * подряд ждут минутами, а синхронный обработчик к тому времени уже вернёт 502.
 * Ожидание — не попытка: бюджет ограничивает ожидание, число попыток внутри
 * провайдеров остаётся их собственным.
 */
const PERSONA_PANEL_BUDGET_MS = 20_000;

/**
 * Больше десяти результатов Serper стоят вдвое (11–100 — два кредита), а
 * панели хватает первой страницы.
 */
export const PERSONA_PANEL_SERPER_LIMIT = 10;

/** Скольким первым кандидатам каждого языка тянется лид; хвост — сниппетом. */
const PERSONA_PANEL_LEADS_PER_LANGUAGE = 3;

/**
 * Сколько строк выдачи попадает в пробу с каждого запроса.
 *
 * Было пять. Малоизвестного человека по пяти заголовкам не узнать: у судьи из
 * прогона DPA-2026-0049 карточки Википедии нет вовсе, а его страницы стоят в
 * выдаче на первых местах — и признак («родился 30.11.1977») живёт в сниппете,
 * а не в заголовке. Десять строк — вся первая страница, за которую уже
 * заплачено: `PERSONA_PANEL_SERPER_LIMIT` = 10, дороже запрос от этого не
 * становится.
 */
const PERSONA_PANEL_SERP_ROWS = 10;

// ---------------------------------------------------------------------------
// Хеш входа субъекта
// ---------------------------------------------------------------------------

/** trim, нижний регистр, схлопывание пробелов, ё→е. */
function normalizeNamePart(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/\s+/gu, " ")
    .trim();
}

/*
 * Разделители, которых не бывает в имени.
 *
 * Пробел разделителем не годится: «Иванов Иван» без алиасов и «Иванов» с
 * алиасом «Иван» дали бы одну строку и один хеш — то есть правка данных
 * субъекта прошла бы мимо ворот. Записаны escape-последовательностями, а не
 * самими байтами: файл с управляющим символом git считает двоичным и диффа по
 * нему не показывает.
 */
const ALIAS_SEPARATOR = "\u0001";
const FIELD_SEPARATOR = "\u0000";

export interface SubjectHashInput {
  fullName: string;
  aliases: string[];
  dateOfBirth: string | null;
}

/**
 * Признак «решение относится к этим данным».
 *
 * Дата рождения входит намеренно: она — сильнейший различитель тёзок, который
 * вводит оператор, и её правка обязана снимать подтверждение. Это другой
 * вопрос, чем у `buildSubjectFingerprint` («принадлежит ли наблюдение
 * субъекту»), поэтому и признак другой.
 */
export function subjectInputHash(input: SubjectHashInput): string {
  const aliases = (input.aliases ?? [])
    .map(normalizeNamePart)
    .filter(Boolean)
    .sort();
  const payload = [
    normalizeNamePart(input.fullName),
    aliases.join(ALIAS_SEPARATOR),
    String(input.dateOfBirth ?? "").trim(),
  ].join(FIELD_SEPARATOR);
  return createHash("sha256").update(payload).digest("hex");
}

// ---------------------------------------------------------------------------
// Снимок панели
// ---------------------------------------------------------------------------

export type PersonaSourceName = "wikipedia" | "knowledge_graph" | "opensanctions" | "yandex";

export type PersonaSourceFetchStatus =
  | "SUCCESS"
  | "NOT_CONFIGURED"
  | "FAILED"
  | "TIMEOUT"
  | "OFFLINE";

/**
 * Причина, по которой источник не дал карточек — закрытым списком.
 *
 * Кабинет переводит её в слова сам: готовая русская фраза, собранная здесь и
 * положенная в снимок, печаталась и в английском кабинете
 * (`Wikipedia: failed — Википедия не ответила: HTTP 429`).
 */
export type PersonaSourceReasonCode =
  | "NETWORK_CALLS_DISABLED"
  | "PERSONA_PANEL_BUDGET_EXCEEDED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_REQUEST_FAILED";

export interface PersonaSourceState {
  source: PersonaSourceName;
  status: PersonaSourceFetchStatus;
  /** Причина машинным кодом; null — источник ответил. */
  code: PersonaSourceReasonCode | null;
  /** Техническая подробность провайдера («HTTP 429»), без готовых фраз. */
  detail: string | null;
  /** Сколько ждали источник; заполнено только у истёкшего бюджета. */
  waitedMs: number | null;
}

export interface PersonaWikipediaArticle {
  language: string;
  title: string;
  url: string;
  lead: string | null;
  snippet: string;
}

export interface PersonaWikipediaCard {
  source: "wikipedia";
  cardId: string;
  title: string;
  lead: string | null;
  /** Лид спрашивали: «не спрашивали» и «статья без текста» — разное. */
  leadRequested: boolean;
  snippet: string;
  /** Одна статья, либо две — только если их связывает межъязыковая ссылка. */
  articles: PersonaWikipediaArticle[];
}

export interface PersonaKnowledgeGraphCard {
  source: "knowledge_graph";
  cardId: string;
  title: string;
  description: string;
  /** Адрес фотографии строкой: файл не сохраняется. */
  imageUrl: string | null;
  url: string | null;
  query: string;
  region: OrionRegionCode;
}

export interface PersonaSanctionsCard {
  source: "opensanctions";
  cardId: string;
  profileId: string | null;
  profileUrl: string | null;
  matchedName: string;
  /** Структурная дата рождения записи — единственная, с которой сверяют. */
  datesOfBirth: string[];
  topicLabels: string[];
  matchScore: number;
  /**
   * Введённая оператором дата совпала со структурной датой записи.
   *
   * Только у этого источника: дата из прозаического лида Википедии не
   * разбирается и не подсвечивается — неверно распарсенная дата с зелёной
   * подсветкой это тихая ложь, хуже отсутствия подсветки.
   */
  birthDateMatches: boolean;
}

export type PersonaCard =
  | PersonaWikipediaCard
  | PersonaKnowledgeGraphCard
  | PersonaSanctionsCard;

export interface PersonaSerpRow {
  title: string;
  /**
   * Сниппет строки — то, ради чего блок и существует: признак субъекта (дата
   * рождения, должность, работодатель) стоит в нём, а не в заголовке.
   */
  snippet: string | null;
  url: string | null;
  domain: string | null;
  /** Чья это выдача: у Яндекса и Google разные однофамильцы в первой десятке. */
  engine: "GOOGLE" | "YANDEX";
}

export interface PersonaPanelSnapshot {
  subjectFullName: string;
  subjectDateOfBirth: string | null;
  cards: PersonaCard[];
  serpRows: PersonaSerpRow[];
  sources: PersonaSourceState[];
  fetchStatus: "SUCCESS" | "FAILED";
  errorCode: string | null;
}

export interface PersonaPanelRequest {
  terms: string[];
  languages: string[];
  serperQueries: Array<{ query: string; region: OrionRegionCode }>;
  budgetMs: number;
}

export interface PersonaPanelSubject {
  caseId: string;
  fullName: string;
  aliases: string[];
  dateOfBirth: string | null;
  nationality?: string | null;
  country?: string | null;
}

export interface PersonaPanelDeps {
  /** Кандидаты одного языкового раздела Википедии с лидами. */
  wikipedia?: (params: {
    language: string;
    terms: string[];
    leadCount: number;
    langlinkTo: string | null;
  }) => Promise<WikipediaNamesakeResult>;
  serper?: (
    request: SearchProviderRequest,
    region: OrionRegionCode,
    limit: number
  ) => Promise<SerperSurfaceBatchResult>;
  /**
   * Выдача Яндекса для пробы: у двух поисковиков разные однофамильцы в первой
   * десятке (офтальмолога из прогона 0049 было видно только у Яндекса).
   */
  yandex?: (request: SearchProviderRequest) => Promise<ProviderRunResult>;
  openSanctions?: (request: ComplianceScreeningRequest) => Promise<ComplianceScreeningResult>;
  /** Общий предел ожидания; по умолчанию — `PERSONA_PANEL_BUDGET_MS`. */
  budgetMs?: number;
}

// ---------------------------------------------------------------------------
// Офлайн и бюджет
// ---------------------------------------------------------------------------

const OFFLINE_CODE = "NETWORK_CALLS_DISABLED";
const BUDGET_CODE = "PERSONA_PANEL_BUDGET_EXCEEDED";

/**
 * Право вето — за окружением.
 *
 * «Разрешение — ключ» держит здесь не всех: без ключа молчит только Serper, а
 * Википедия и OpenSanctions включены по умолчанию и ключа не требуют — в
 * офлайне они ушли бы в сеть по-настоящему. Подменённый источник сетью не
 * является, поэтому вето его не касается: на этом и держится офлайн-тест.
 */
function offlineDenied(impl: unknown): boolean {
  return !impl && String(process.env.NETWORK_CALLS ?? "") === "0";
}

type SourceOutcome<T> =
  | { status: "SUCCESS"; value: T }
  | { status: "TIMEOUT" }
  | { status: "FAILED"; message: string };

/** Ответивший источник. */
function sourceAnswered(
  source: PersonaSourceName,
  status: PersonaSourceFetchStatus = "SUCCESS",
  code: PersonaSourceReasonCode | null = null,
  detail: string | null = null
): PersonaSourceState {
  return { source, status, code, detail, waitedMs: null };
}

/**
 * Источник, ответа от которого нет. Три случая различаются кодом, а не
 * молчанием: «не спрашивали», «не дождались» и «отказал» требуют от оператора
 * разного, и записывать один другим нельзя.
 */
function sourceSilent(
  source: PersonaSourceName,
  outcome: { status: "TIMEOUT" } | { status: "FAILED"; message: string } | null,
  budgetMs: number
): PersonaSourceState {
  if (!outcome) return sourceAnswered(source, "OFFLINE", OFFLINE_CODE);
  if (outcome.status === "TIMEOUT") {
    return { ...sourceAnswered(source, "TIMEOUT", BUDGET_CODE), waitedMs: budgetMs };
  }
  return sourceAnswered(source, "FAILED", "PROVIDER_REQUEST_FAILED", outcome.message);
}

async function withBudget<T>(budgetMs: number, task: () => Promise<T>): Promise<SourceOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<SourceOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "TIMEOUT" }), budgetMs);
  });
  const work = task().then(
    (value): SourceOutcome<T> => ({ status: "SUCCESS", value }),
    (err: unknown): SourceOutcome<T> => ({
      status: "FAILED",
      message: err instanceof Error ? err.message : String(err),
    })
  );
  try {
    return await Promise.race([work, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Сборка панели
// ---------------------------------------------------------------------------

/** Формы имени спрашиваются у того же кода, что строит их для сбора. */
function serperQueries(terms: string[]): Array<{ query: string; region: OrionRegionCode }> {
  const first = terms[0];
  if (!first) return [];
  const queries: Array<{ query: string; region: OrionRegionCode }> = [
    { query: first, region: "RU" },
  ];
  const latin = terms.find((t) => t !== first && !hasCyrillic(t));
  if (latin) queries.push({ query: latin, region: "INTERNATIONAL" });
  return queries;
}

function wikipediaCards(results: WikipediaNamesakeResult[]): PersonaWikipediaCard[] {
  const cards: PersonaWikipediaCard[] = [];
  const merged = new Set<string>();
  for (const [i, result] of results.entries()) {
    for (const candidate of result.candidates) {
      if (merged.has(`${result.language}:${candidate.title}`)) continue;
      const articles: PersonaWikipediaArticle[] = [
        {
          language: result.language,
          title: candidate.title,
          url: candidate.url,
          lead: candidate.lead,
          snippet: candidate.snippet,
        },
      ];
      // Склейка разделов только по межъязыковой ссылке: это утверждение самой
      // Википедии о тождестве, а не наша догадка по совпадению имён.
      if (candidate.langlinkTitle) {
        for (const other of results.slice(i + 1)) {
          const twin = other.candidates.find((c) => c.title === candidate.langlinkTitle);
          if (!twin) continue;
          articles.push({
            language: other.language,
            title: twin.title,
            url: twin.url,
            lead: twin.lead,
            snippet: twin.snippet,
          });
          merged.add(`${other.language}:${twin.title}`);
        }
      }
      cards.push({
        source: "wikipedia",
        cardId: `wikipedia:${result.language}:${candidate.title}`,
        title: candidate.title,
        lead: candidate.lead,
        leadRequested: candidate.leadRequested,
        snippet: candidate.snippet,
        articles,
      });
    }
  }
  return cards;
}

interface SerperSlice {
  cards: PersonaKnowledgeGraphCard[];
  serpRows: PersonaSerpRow[];
  status: PersonaSourceFetchStatus;
  code: PersonaSourceReasonCode | null;
  detail: string | null;
}

function serperSlice(
  batches: Array<{ query: string; region: OrionRegionCode; batch: SerperSurfaceBatchResult }>
): SerperSlice {
  const cards: PersonaKnowledgeGraphCard[] = [];
  const serpRows: PersonaSerpRow[] = [];
  let status: PersonaSourceFetchStatus = "SUCCESS";
  let code: PersonaSourceReasonCode | null = null;
  let detail: string | null = null;
  let anySuccess = false;

  for (const { query, region, batch } of batches) {
    if (batch.status !== "SUCCESS") {
      if (!code) {
        status = batch.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "FAILED";
        code =
          batch.status === "NOT_CONFIGURED" ? "PROVIDER_NOT_CONFIGURED" : "PROVIDER_REQUEST_FAILED";
        detail = batch.error ?? null;
      }
      continue;
    }
    anySuccess = true;
    // Свой предел строк на каждый запрос: общий сделал бы состав блока
    // зависимым от того, чей ответ разобрали первым.
    let rowsOfBatch = 0;
    for (const item of batch.items) {
      const surface = String(
        (item.rawMetadataSafe as Record<string, unknown> | undefined)?.surface ?? ""
      );
      // Готовый ответ поисковика приходит тем же полем `knowledgePanel`, но
      // сущностью-человеком не является и карточкой стать не может.
      if (item.kind === "knowledgePanel" && surface === "knowledgeGraph") {
        cards.push({
          source: "knowledge_graph",
          cardId: `knowledge_graph:${region}:${item.title}`,
          title: item.title,
          description: item.snippet,
          imageUrl: item.imageUrl,
          url: item.url,
          query,
          region,
        });
        continue;
      }
      if (item.kind === "organic" && rowsOfBatch < PERSONA_PANEL_SERP_ROWS) {
        rowsOfBatch += 1;
        serpRows.push({
          title: item.title,
          snippet: item.snippet ?? null,
          url: item.url,
          domain: item.domain,
          engine: "GOOGLE",
        });
      }
    }
  }
  if (anySuccess) return { cards, serpRows, status: "SUCCESS", code: null, detail: null };
  return { cards, serpRows, status, code, detail };
}

function sanctionsCards(
  result: ComplianceScreeningResult,
  dateOfBirth: string | null
): PersonaSanctionsCard[] {
  // Порядок — тот, что дал провайдер: сильнейшее совпадение первым.
  return result.hits.map((hit) => ({
    source: "opensanctions" as const,
    cardId: `opensanctions:${hit.profileId ?? hit.matchedName}`,
    profileId: hit.profileId ?? null,
    profileUrl: hit.profileUrl ?? null,
    matchedName: hit.matchedName,
    datesOfBirth: hit.datesOfBirth,
    topicLabels: [...new Set(hit.riskTypes.map((t) => RISK_TYPE_LABEL_RU[t]))].filter(Boolean),
    matchScore: hit.matchScore,
    birthDateMatches: Boolean(dateOfBirth) && hit.datesOfBirth.includes(String(dateOfBirth)),
  }));
}

/**
 * Срез различимых персон из уже подключённых источников.
 *
 * Источники опрашиваются параллельно под общим бюджетом; отказ любого из них
 * деградирует панель словами и её не отменяет. Пустая панель — валидный
 * результат, а не ошибка: путь «продолжить без выбора» существует всегда.
 */
export async function buildPersonaPanel(input: {
  subject: PersonaPanelSubject;
  deps?: PersonaPanelDeps;
}): Promise<{ request: PersonaPanelRequest; snapshot: PersonaPanelSnapshot }> {
  const deps = input.deps ?? {};
  const budgetMs = deps.budgetMs ?? PERSONA_PANEL_BUDGET_MS;
  const subject = input.subject;
  const terms = subjectTerms(subject.fullName, subject.aliases ?? []);
  const languages = providerConfig.wikipedia.languages;
  const queries = serperQueries(terms);

  const request: PersonaPanelRequest = {
    terms,
    languages,
    serperQueries: queries,
    budgetMs,
  };

  const sources: PersonaSourceState[] = [];
  const cards: PersonaCard[] = [];
  let serpRows: PersonaSerpRow[] = [];

  const wikipediaImpl = deps.wikipedia;
  const serperImpl = deps.serper;
  const openSanctionsImpl = deps.openSanctions;

  const wikipediaTask = offlineDenied(wikipediaImpl)
    ? null
    : withBudget(budgetMs, async () => {
        const impl =
          wikipediaImpl ?? ((params) => wikipediaProvider.listNamesakeCandidates(params));
        const results: WikipediaNamesakeResult[] = [];
        for (const [i, language] of languages.entries()) {
          results.push(
            await impl({
              language,
              terms,
              leadCount: PERSONA_PANEL_LEADS_PER_LANGUAGE,
              // Ссылка спрашивается один раз, из первого раздела во второй:
              // склейка симметрична, а вызов стоит времени.
              langlinkTo: i === 0 ? languages[1] ?? null : null,
            })
          );
        }
        return results;
      });

  const serperTask = offlineDenied(serperImpl)
    ? null
    : withBudget(budgetMs, async () => {
        const impl = serperImpl ?? serperOrganicWithExtras;
        const batches: Array<{
          query: string;
          region: OrionRegionCode;
          batch: SerperSurfaceBatchResult;
        }> = [];
        for (const { query, region } of queries) {
          batches.push({
            query,
            region,
            batch: await impl(
              {
                caseId: subject.caseId,
                subjectFullName: subject.fullName,
                aliases: subject.aliases ?? [],
                query,
              },
              region,
              PERSONA_PANEL_SERPER_LIMIT
            ),
          });
        }
        return batches;
      });

  const yandexImpl = deps.yandex;
  const yandexTask = offlineDenied(yandexImpl)
    ? null
    : withBudget(budgetMs, async () => {
        const impl = yandexImpl ?? ((request: SearchProviderRequest) => yandexSearchProvider.search(request));
        return impl({
          caseId: subject.caseId,
          subjectFullName: subject.fullName,
          aliases: subject.aliases ?? [],
          query: terms[0] ?? subject.fullName,
          region: "RU",
          language: "ru",
          limit: PERSONA_PANEL_SERP_ROWS,
        });
      });

  const sanctionsTask = offlineDenied(openSanctionsImpl)
    ? null
    : withBudget(budgetMs, async () => {
        const impl =
          openSanctionsImpl ?? ((req: ComplianceScreeningRequest) => openSanctionsProvider.screenPerson(req));
        return impl({
          caseId: subject.caseId,
          subjectFullName: subject.fullName,
          aliases: subject.aliases ?? [],
          dateOfBirth: subject.dateOfBirth,
          nationality: subject.nationality ?? null,
          country: subject.country ?? null,
        });
      });

  const [wikipediaOutcome, serperOutcome, yandexOutcome, sanctionsOutcome] = await Promise.all([
    wikipediaTask,
    serperTask,
    yandexTask,
    sanctionsTask,
  ]);

  // --- Википедия
  if (wikipediaOutcome?.status === "SUCCESS") {
    cards.push(...wikipediaCards(wikipediaOutcome.value));
    sources.push(sourceAnswered("wikipedia"));
  } else {
    sources.push(sourceSilent("wikipedia", wikipediaOutcome, budgetMs));
  }

  // --- Панель знаний Google
  if (serperOutcome?.status === "SUCCESS") {
    const slice = serperSlice(serperOutcome.value);
    cards.push(...slice.cards);
    serpRows = slice.serpRows;
    sources.push(sourceAnswered("knowledge_graph", slice.status, slice.code, slice.detail));
  } else {
    sources.push(sourceSilent("knowledge_graph", serperOutcome, budgetMs));
  }

  // --- Выдача Яндекса
  if (yandexOutcome?.status !== "SUCCESS") {
    sources.push(sourceSilent("yandex", yandexOutcome, budgetMs));
  } else if (yandexOutcome.value.status === "SUCCESS") {
    serpRows = [
      ...serpRows,
      ...yandexOutcome.value.results.slice(0, PERSONA_PANEL_SERP_ROWS).map((r) => ({
        title: r.title,
        snippet: r.snippet ?? null,
        url: r.url ?? null,
        domain: r.domain ?? null,
        engine: "YANDEX" as const,
      })),
    ];
    sources.push(sourceAnswered("yandex"));
  } else {
    const notConfigured =
      yandexOutcome.value.status === "NOT_CONFIGURED" || yandexOutcome.value.status === "DISABLED";
    sources.push(
      sourceAnswered(
        "yandex",
        notConfigured ? "NOT_CONFIGURED" : "FAILED",
        notConfigured ? "PROVIDER_NOT_CONFIGURED" : "PROVIDER_REQUEST_FAILED",
        yandexOutcome.value.error
          ? [yandexOutcome.value.error.code, yandexOutcome.value.error.message]
              .filter(Boolean)
              .join(": ")
          : null
      )
    );
  }

  // --- Санкционные и PEP-списки
  if (sanctionsOutcome?.status !== "SUCCESS") {
    sources.push(sourceSilent("opensanctions", sanctionsOutcome, budgetMs));
  } else if (sanctionsOutcome.value.status === "SUCCESS") {
    cards.push(...sanctionsCards(sanctionsOutcome.value, subject.dateOfBirth));
    sources.push(sourceAnswered("opensanctions"));
  } else {
    // Провайдер ответил отказом, а не промолчал: собственный код и сообщение
    // провайдера остаются подробностью — кодов у снимка свой закрытый список.
    const notConfigured =
      sanctionsOutcome.value.status === "NOT_CONFIGURED" ||
      sanctionsOutcome.value.status === "DISABLED";
    const error = sanctionsOutcome.value.error;
    sources.push(
      sourceAnswered(
        "opensanctions",
        notConfigured ? "NOT_CONFIGURED" : "FAILED",
        notConfigured ? "PROVIDER_NOT_CONFIGURED" : "PROVIDER_REQUEST_FAILED",
        error ? [error.code, error.message].filter(Boolean).join(": ") : null
      )
    );
  }

  const answered = sources.some((s) => s.status === "SUCCESS");
  const fetchStatus = answered ? "SUCCESS" : "FAILED";
  const allOffline = sources.every((s) => s.status === "OFFLINE");
  return {
    request,
    snapshot: {
      subjectFullName: subject.fullName,
      subjectDateOfBirth: subject.dateOfBirth,
      cards,
      serpRows,
      sources,
      fetchStatus,
      errorCode: answered ? null : allOffline ? OFFLINE_CODE : "ALL_SOURCES_FAILED",
    },
  };
}

// ---------------------------------------------------------------------------
// Хранение строки и решения
// ---------------------------------------------------------------------------

/**
 * Ответ оператора на вопрос «про кого собираем».
 *
 * `ANCHORS_CONFIRMED` — «карточки его не нашли, но я знаю, чем он отличается»:
 * для малоизвестного человека это единственный честный ответ, и он несёт
 * признаки, а не слово. `APPROVED_WITHOUT_PERSONA` остаётся ответом «не знаю» —
 * ворота его больше не принимают за подтверждение (см. `personaGateState`).
 */
export type PersonaDecision =
  | "PERSONA_SELECTED"
  | "ANCHORS_CONFIRMED"
  | "APPROVED_WITHOUT_PERSONA";

export interface PersonaCheckRow {
  id: string;
  caseId: string;
  subjectInputHash: string;
  requestJson: unknown;
  personasJson: unknown;
  fetchStatus: string;
  errorCode: string | null;
  searchedBy: string | null;
  searchedAt: Date | string;
  decision: string | null;
  selectedPersonaJson: unknown;
  decidedBy: string | null;
  decidedAt: Date | string | null;
}

export interface PersonaCheckDelegate {
  create(args: { data: Record<string, unknown> }): Promise<PersonaCheckRow>;
  findFirst(args: unknown): Promise<PersonaCheckRow | null>;
  findMany(args: unknown): Promise<Array<{ subjectInputHash: string }>>;
  update(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }): Promise<PersonaCheckRow>;
}

export interface PersonaCheckPrisma {
  subjectPersonaCheck: PersonaCheckDelegate;
}

export interface PersonaStoreDeps {
  prisma?: PersonaCheckPrisma | null;
  now?: () => Date;
}

export interface PersonaGateDeps extends PersonaStoreDeps {
  loadSubject?: (caseId: string) => Promise<CaseSubjectInfo>;
}

function db(deps?: PersonaStoreDeps): PersonaCheckPrisma {
  return deps?.prisma ?? (prisma as unknown as PersonaCheckPrisma);
}

/** Якоря выбранной карточки — обязательство перед последующим сбором. */
interface PersonaSelectionSnapshot {
  source: PersonaSourceName | "anchors";
  anchors: Record<string, unknown>;
  /** Карточка целиком — такой, какой её видел оператор; у якорей её нет. */
  card?: PersonaCard;
  /** Итог пробы: где каждый якорь сработал и какие строки его опровергли. */
  probe?: AnchorProbeResult;
}

function anchorsOf(card: PersonaCard): Record<string, unknown> {
  if (card.source === "wikipedia") {
    return {
      articles: card.articles.map((a) => ({
        language: a.language,
        title: a.title,
        url: a.url,
      })),
    };
  }
  if (card.source === "opensanctions") {
    return { profileId: card.profileId, profileUrl: card.profileUrl };
  }
  return { title: card.title, description: card.description, imageUrl: card.imageUrl };
}

/** Какая карточка выбрана записанным решением; null — решение без карточки. */
function selectedCardIdOf(row: PersonaCheckRow): string | null {
  const selected = row.selectedPersonaJson as PersonaSelectionSnapshot | null;
  return selected?.card?.cardId ?? null;
}

function cardsOf(personasJson: unknown): PersonaCard[] {
  const snapshot = personasJson as PersonaPanelSnapshot | null;
  return Array.isArray(snapshot?.cards) ? snapshot.cards : [];
}

function serpRowsOf(personasJson: unknown): PersonaSerpRow[] {
  const snapshot = personasJson as PersonaPanelSnapshot | null;
  return Array.isArray(snapshot?.serpRows) ? snapshot.serpRows : [];
}

/**
 * Проба якорей по сохранённому снимку панели.
 *
 * Считается при каждом чтении, а не замораживается в снимке: оператор правит
 * признаки после сбора панели и должен увидеть новый ответ, не покупая
 * панель заново. `null` — признаков нет вовсе, и это не пустая проба: «ничего
 * не нашли» и «нечего искать» — разные ответы.
 */
export function personaProbeOfCheck(input: {
  personasJson: unknown;
  anchors: SubjectAnchors | null | undefined;
}): AnchorProbeResult | null {
  const anchors = input.anchors ?? null;
  if (!anchors || !hasSubjectAnchors(anchors)) return null;
  const rows = serpRowsOf(input.personasJson);
  if (rows.length === 0) return null;
  return checkAnchorsInProbe({ anchors, rows });
}

export async function recordPersonaCheck(input: {
  caseId: string;
  subjectInputHash: string;
  request: PersonaPanelRequest;
  snapshot: PersonaPanelSnapshot;
  searchedBy?: string | null;
  deps?: PersonaStoreDeps;
}): Promise<PersonaCheckRow> {
  return db(input.deps).subjectPersonaCheck.create({
    data: {
      caseId: input.caseId,
      subjectInputHash: input.subjectInputHash,
      requestJson: input.request,
      personasJson: input.snapshot,
      fetchStatus: input.snapshot.fetchStatus,
      errorCode: input.snapshot.errorCode,
      searchedBy: input.searchedBy ?? null,
    },
  });
}

/** Последняя сборка панели этого кейса — вход панели оператора. */
export async function loadLatestPersonaCheck(
  caseId: string,
  deps?: PersonaStoreDeps
): Promise<PersonaCheckRow | null> {
  return db(deps).subjectPersonaCheck.findFirst({
    where: { caseId },
    orderBy: { searchedAt: "desc" },
  });
}

/** Заголовок карточки так, как его видел оператор. */
function cardTitle(card: PersonaCard): string {
  return card.source === "opensanctions" ? card.matchedName : card.title;
}

/** Адрес карточки; null — источник адреса не дал. */
function cardUrl(card: PersonaCard): string | null {
  if (card.source === "wikipedia") return card.articles[0]?.url ?? null;
  if (card.source === "opensanctions") return card.profileUrl;
  return card.url;
}

/**
 * Снимок решения для отчёта — единственное место, где строка панели
 * превращается в то, что увидит читатель.
 *
 * `null` значит ровно «решения по кейсу нет»: собранная, но нерешённая панель
 * решением не является — ворота её и не считают.
 *
 * В снимок едет только проверяемое: источник, заголовок, адрес и **структурная**
 * дата рождения записи. Лид статьи не разбирается на дату и не пересказывается,
 * оценка совпадения не переносится вовсе — процент рядом с именем читается как
 * подтверждение личности, которым он не является.
 */
export function personaDecisionForReport(
  row: PersonaCheckRow | null
): PersonaDecisionRecord | null {
  if (!row?.decision) return null;
  const decision = row.decision as PersonaDecision;
  const snapshot = row.personasJson as PersonaPanelSnapshot | null;
  const selection = row.selectedPersonaJson as PersonaSelectionSnapshot | null;
  const selectedCard = selection?.card ?? null;
  /*
   * Признаки решения едут в отчёт вместе с адресами, на которых они нашлись:
   * лист «Кого проверяли» обязан быть проверяемым читателем, а признак без
   * адреса проверить нечем.
   */
  const anchors =
    selection?.source === "anchors"
      ? (() => {
          const a = selection.anchors as unknown as SubjectAnchors;
          const confirmedOn = [
            ...new Set(
              (selection.probe?.hits ?? [])
                .flatMap((h) => h.rows.map((r) => r.url ?? r.domain ?? ""))
                .filter(Boolean)
            ),
          ];
          return { ...a, confirmedOn };
        })()
      : null;
  return {
    decision,
    ...(anchors ? { anchors } : {}),
    selected: selectedCard
      ? {
          source: selectedCard.source,
          title: cardTitle(selectedCard),
          url: cardUrl(selectedCard),
          datesOfBirth:
            selectedCard.source === "opensanctions" ? selectedCard.datesOfBirth : [],
        }
      : null,
    // Причина отказа едет вместе с состоянием: без неё лист «Кого проверяли»
    // выдумывал «источник не ответил» там, где источник ответил отказом.
    sources: (snapshot?.sources ?? []).map((s) => ({
      source: s.source,
      status: s.status,
      ...(s.code ? { code: s.code } : {}),
    })),
    cardCount: cardsOf(row.personasJson).length,
    decidedAt: row.decidedAt ? new Date(row.decidedAt).toISOString() : null,
  };
}

/**
 * Решение по строке пишется один раз.
 *
 * «Переголосовать» задним числом нельзя намеренно: иначе оплаченный прогон
 * стартовал бы по решению, которого уже нет. Новое решение — только новой
 * сборкой панели; ошибка в сторону строгости здесь дешевле.
 */
export async function recordPersonaDecision(input: {
  caseId: string;
  checkId: string;
  decision: PersonaDecision;
  selectedCardId?: string | null;
  /** Признаки субъекта — обязательны для `ANCHORS_CONFIRMED`. */
  anchors?: SubjectAnchors | null;
  decidedBy?: string | null;
  deps?: PersonaStoreDeps;
}): Promise<PersonaCheckRow> {
  const client = db(input.deps);
  const row = await client.subjectPersonaCheck.findFirst({
    where: { id: input.checkId, caseId: input.caseId },
  });
  if (!row) throw new NotFoundError("Persona check not found");
  if (row.decision) {
    /*
     * Аудит пишется после решения и падает сам по себе: решение записано,
     * оператор видит ошибку и жмёт ещё раз. Тот же ответ ничего не меняет —
     * отказывать на него значит показать отказ ворот там, где ворота уже
     * открыты. Другой ответ по той же строке по-прежнему отвергается:
     * «переголосовать» задним числом означало бы, что оплаченный прогон
     * стартовал по решению, которого уже нет.
     */
    const sameAnswer =
      row.decision === input.decision &&
      selectedCardIdOf(row) === (input.selectedCardId ?? null);
    if (sameAnswer) return row;
    throw new ConflictError(`persona check ${row.id} already decided (${row.decision})`, {
      reason: "PERSONA_DECISION_ALREADY_RECORDED",
    });
  }

  let selected: PersonaSelectionSnapshot | null = null;
  if (input.decision === "PERSONA_SELECTED") {
    const card = cardsOf(row.personasJson).find((c) => c.cardId === input.selectedCardId);
    if (!card) {
      throw new ValidationError("selected persona card is not part of this panel snapshot");
    }
    selected = { source: card.source, anchors: anchorsOf(card), card };
  }
  if (input.decision === "ANCHORS_CONFIRMED") {
    /*
     * Решение по якорям записывается только вместе с признаком, который
     * действительно различает людей. Слабый якорь — одно слово вроде «судья» —
     * стоит и в чужих текстах: подтверждать им принадлежность значило бы
     * повторить прогон 0049 другими словами.
     */
    const anchors = input.anchors ?? null;
    if (!anchors || !hasStrongSubjectAnchor(anchors)) {
      throw new ValidationError(
        "anchors decision needs at least one strong anchor (birth date, employer, position, INN or domain)"
      );
    }
    const rows = serpRowsOf(row.personasJson);
    selected = {
      source: "anchors",
      anchors: anchors as unknown as Record<string, unknown>,
      // Итог пробы записывается вместе с решением: лист «Кого проверяли»
      // печатает, какие признаки проверялись и на каких адресах они нашлись.
      probe: checkAnchorsInProbe({ anchors, rows }),
    };
  }

  return client.subjectPersonaCheck.update({
    where: { id: row.id },
    data: {
      decision: input.decision,
      selectedPersonaJson: selected,
      decidedBy: input.decidedBy ?? null,
      decidedAt: (input.deps?.now ?? (() => new Date()))(),
    },
  });
}

// ---------------------------------------------------------------------------
// Ворота
// ---------------------------------------------------------------------------

export type PersonaGateMode = "FIXTURE_BYPASS" | "CONFIRMED" | "STALE" | "PENDING";

/** Причина закрытых ворот; она же уходит клиенту в `details.reason`. */
export type PersonaGateBlockReason =
  | "PERSONA_NOT_CONFIRMED"
  | "PERSONA_DECISION_STALE"
  | "SUBJECT_ANCHORS_MISSING"
  | "PERSONA_GATE_UNAVAILABLE";

export interface PersonaGateInput {
  isFixture: boolean;
  subjectInputHash: string;
  /** Хеши входа субъекта на момент уже принятых решений этого кейса. */
  decidedHashes: string[];
  /**
   * Назван ли хоть один сильный признак субъекта (дата рождения кейса, якорь
   * профиля). Без него платный сбор не отличит субъекта от полного тёзки.
   */
  hasSubjectAnchor: boolean;
}

/**
 * Закрытые ворота всегда несут причину, которую клиент умеет перевести в слова:
 * это утверждает тип, а не соглашение между вызывающими.
 */
export type PersonaGateState =
  | { mode: "FIXTURE_BYPASS" | "CONFIRMED"; reason: string }
  | { mode: "PENDING" | "STALE"; reason: PersonaGateBlockReason };

/**
 * Единственный ответ на вопрос ворот: чистая функция без базы и без сети.
 *
 * Признак задаётся данными: «подтверждено» ⇔ среди решённых строк кейса есть
 * строка с хешем нынешних данных субъекта. Пятого состояния здесь нет —
 * недоступность загрузчика выставляет вызывающий, и она ворота **закрывает**.
 */
export function personaGateState(input: PersonaGateInput): PersonaGateState {
  if (input.isFixture) {
    return { mode: "FIXTURE_BYPASS", reason: "PERSONA_GATE_FIXTURE_CASE" };
  }
  /*
   * Признак важнее нажатой кнопки.
   *
   * Прогон DPA-2026-0049 открыл ворота ответом «различимой персоны нет»: слово
   * записано, а отличить субъекта от четырёх тёзок было нечем. Сначала
   * спрашивается, есть ли признак, — и только потом, названо ли решение.
   */
  if (!input.hasSubjectAnchor) {
    return { mode: "PENDING", reason: "SUBJECT_ANCHORS_MISSING" };
  }
  if (input.decidedHashes.includes(input.subjectInputHash)) {
    return { mode: "CONFIRMED", reason: "PERSONA_DECISION_MATCHES_SUBJECT" };
  }
  if (input.decidedHashes.length > 0) {
    return { mode: "STALE", reason: "PERSONA_DECISION_STALE" };
  }
  return { mode: "PENDING", reason: "PERSONA_NOT_CONFIRMED" };
}

/** Данные для предиката. Загрузчик отдаёт данные, решение принимает функция. */
export async function loadPersonaGateInput(
  caseId: string,
  deps?: PersonaGateDeps
): Promise<PersonaGateInput> {
  const subject = await (deps?.loadSubject ?? loadCaseSubject)(caseId);
  const rows = await db(deps).subjectPersonaCheck.findMany({
    where: { caseId, decision: { not: null } },
    orderBy: { decidedAt: "desc" },
    take: 50,
    select: { subjectInputHash: true },
  });
  return {
    isFixture: subject.isFixture,
    subjectInputHash: subjectInputHash(subject),
    decidedHashes: rows.map((r) => r.subjectInputHash),
    // Признак берётся из данных: дата рождения кейса либо якорь профиля.
    hasSubjectAnchor:
      Boolean(subject.dateOfBirth) ||
      hasStrongSubjectAnchor(loadCaseSubjectIdentityProfile(caseId)?.anchors ?? null),
  };
}

/** Человеческого текста здесь нет: он живёт в словарях i18n, по коду причины. */
export const PERSONA_GATE_BLOCK_MESSAGE: Record<PersonaGateBlockReason, string> = {
  PERSONA_NOT_CONFIRMED:
    "persona for this subject is not chosen yet; open the persona panel and decide before a paid run",
  PERSONA_DECISION_STALE:
    "subject data changed after the persona decision; rebuild the persona panel and decide again",
  SUBJECT_ANCHORS_MISSING:
    "no subject anchor yet: add the birth date or a distinguishing fact (employer, position, INN) before a paid run",
  PERSONA_GATE_UNAVAILABLE:
    "persona gate state could not be read; a paid run does not start on an unknown gate",
};
