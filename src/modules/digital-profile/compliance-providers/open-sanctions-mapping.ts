/**
 * OpenSanctions: построение запроса и разбор ответа (шаг 04.3).
 *
 * Раздел комплаенса никогда не наполнялся реальными данными: подписок на
 * LexisNexis / Dow Jones / World-Check нет, а до перехода на `real_only` его
 * заполняли демо-агенты. Синтетическое «совпадение по санкционным спискам» в
 * документе о реальном человеке недопустимо, поэтому раздел стоял честно пустым.
 *
 * OpenSanctions — открытый агрегатор санкционных списков, перечней PEP и
 * розыска. Он не заменяет глубину LexisNexis по судебным и медийным записям, но
 * закрывает главный вопрос комплаенса законно и без закупки.
 *
 * Здесь только чистые функции: сеть живёт в `open-sanctions-provider.ts`.
 * Разбор написан защитно — у провайдера открытая модель данных, и поле, которого
 * нет, должно означать «нет сведений», а не падение прогона.
 */

import type {
  ComplianceConfidenceLevel,
  ComplianceRiskType,
  ComplianceScreeningHit,
} from "./types";

/** Идентификатор запроса в пакетном матчинге: один субъект — один запрос. */
export const OPEN_SANCTIONS_QUERY_ID = "subject";

export interface OpenSanctionsQueryInput {
  fullName: string;
  aliases?: string[];
  dateOfBirth?: string | null;
  country?: string | null;
  nationality?: string | null;
}

/**
 * Тело запроса `POST /match/{dataset}`.
 *
 * Отчество и алиасы передаются как дополнительные значения `name`: у провайдера
 * имя — многозначное свойство, и это единственный способ дать ему все формы
 * написания, не размывая запрос.
 */
export function buildOpenSanctionsMatchBody(input: OpenSanctionsQueryInput): {
  queries: Record<string, { schema: "Person"; properties: Record<string, string[]> }>;
} {
  const names = [input.fullName, ...(input.aliases ?? [])]
    .map((n) => String(n ?? "").trim())
    .filter(Boolean);
  const properties: Record<string, string[]> = { name: [...new Set(names)] };

  const birthDate = normalizeBirthDate(input.dateOfBirth);
  if (birthDate) properties.birthDate = [birthDate];

  const countries = [input.country, input.nationality]
    .map((c) => String(c ?? "").trim().toLowerCase())
    .filter(Boolean);
  if (countries.length > 0) properties.country = [...new Set(countries)];

  return {
    queries: {
      [OPEN_SANCTIONS_QUERY_ID]: { schema: "Person", properties },
    },
  };
}

/**
 * Дата рождения в формате провайдера (`YYYY-MM-DD` или `YYYY`).
 *
 * Пустая строка вместо мусора: неверный формат провайдер отвергает целиком,
 * то есть один плохо заполненный кейс обнулил бы проверку по санкциям.
 */
export function normalizeBirthDate(value: string | null | undefined): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const iso = /^(\d{4})-(\d{2})-(\d{2})/u.exec(raw);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const yearOnly = /^(\d{4})$/u.exec(raw);
  if (yearOnly) return yearOnly[1];
  // Дата как объект Date, пришедшая через JSON.
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return "";
}

/**
 * Темы OpenSanctions → типы риска отчёта.
 *
 * Темы иерархичны (`role.pep`, `crime.fraud`), поэтому сопоставление идёт по
 * префиксу: новая подтема провайдера попадёт в свой раздел сама, а не в «прочее».
 */
const TOPIC_PREFIX_TO_RISK: Array<[string, ComplianceRiskType]> = [
  ["sanction", "SANCTIONS"],
  ["role.pep", "PEP"],
  ["role.rca", "PEP"],
  ["role.oligarch", "POLITICAL_EXPOSURE"],
  ["gov", "POLITICAL_EXPOSURE"],
  ["poi", "WATCHLIST"],
  ["wanted", "LAW_ENFORCEMENT"],
  ["crime", "LAW_ENFORCEMENT"],
  ["debarment", "WATCHLIST"],
  ["export.control", "WATCHLIST"],
  ["reg.warn", "WATCHLIST"],
  ["reg.action", "LEGAL"],
  ["corp.disqual", "LEGAL"],
];

export function riskTypesFromTopics(topics: readonly string[]): ComplianceRiskType[] {
  const found = new Set<ComplianceRiskType>();
  for (const topic of topics) {
    const t = String(topic ?? "").trim().toLowerCase();
    if (!t) continue;
    for (const [prefix, risk] of TOPIC_PREFIX_TO_RISK) {
      if (t === prefix || t.startsWith(`${prefix}.`)) found.add(risk);
    }
  }
  // Сущность без распознанной темы всё равно найдена в базе комплаенса —
  // умолчать об этом нельзя, поэтому она попадает в «прочее», а не исчезает.
  if (found.size === 0) found.add("OTHER");
  return [...found];
}

/**
 * Уверенность по счёту сходства.
 *
 * Границы намеренно строгие: у отчёта нет права называть совпадение уверенным
 * за субъекта, поэтому всё, что ниже 0.8, попадает аналитику на сверку.
 */
export function confidenceFromScore(score: number): ComplianceConfidenceLevel {
  if (score >= 0.9) return "HIGH";
  if (score >= 0.8) return "MEDIUM";
  return "LOW";
}

/** Значения многозначного свойства сущности. */
function props(entity: Record<string, unknown>, key: string): string[] {
  const p = entity.properties;
  if (!p || typeof p !== "object") return [];
  const value = (p as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v ?? "").trim()).filter(Boolean);
}

function firstNonEmpty(values: string[]): string {
  return values.find((v) => v.length > 0) ?? "";
}

/** Кратко о совпадении: списки, где числится, и роль. */
export function summarizeEntity(entity: Record<string, unknown>): string {
  const datasets = Array.isArray(entity.datasets)
    ? entity.datasets.map((d) => String(d ?? "").trim()).filter(Boolean)
    : [];
  const topics = props(entity, "topics");
  const position = firstNonEmpty(props(entity, "position"));
  const parts: string[] = [];
  if (topics.length > 0) parts.push(`темы: ${topics.join(", ")}`);
  if (position) parts.push(`должность: ${position}`);
  if (datasets.length > 0) parts.push(`источники: ${datasets.slice(0, 5).join(", ")}`);
  return parts.length > 0 ? parts.join("; ") : "запись в базе OpenSanctions без дополнительных сведений";
}

export interface OpenSanctionsMappingInput {
  subjectName: string;
  /** Разобранный JSON ответа `POST /match/{dataset}`. */
  payload: unknown;
  /** Ниже этого счёта совпадение в отчёт не попадает. */
  minScore: number;
  /** Базовый адрес — из него собирается ссылка на карточку сущности. */
  webBaseUrl: string;
}

/**
 * Ответ провайдера → совпадения отчёта.
 *
 * Ни одно совпадение не подтверждается автоматически: `reviewStatus` всегда
 * `PENDING`. Совпадение по имени — это повод для проверки, а не факт о
 * человеке, и решение о нём принимает аналитик (то же правило, что для
 * ручного импорта).
 */
export function mapOpenSanctionsResponse(
  input: OpenSanctionsMappingInput
): ComplianceScreeningHit[] {
  const results = extractResults(input.payload);
  const hits: ComplianceScreeningHit[] = [];

  for (const entity of results) {
    const score = Number(entity.score ?? 0);
    if (!Number.isFinite(score) || score < input.minScore) continue;

    const id = String(entity.id ?? "").trim();
    const matchedName =
      String(entity.caption ?? "").trim() || firstNonEmpty(props(entity, "name"));
    if (!matchedName) continue;

    const topics = props(entity, "topics");
    hits.push({
      provider: "OPEN_SANCTIONS",
      source: "OFFICIAL_API",
      subjectName: input.subjectName,
      matchedName,
      aliases: props(entity, "alias"),
      categories: topics,
      riskTypes: riskTypesFromTopics(topics),
      countries: [...new Set([...props(entity, "country"), ...props(entity, "nationality")])],
      datesOfBirth: props(entity, "birthDate"),
      // Счёт провайдера — доля от единицы; отчёт везде оперирует процентами.
      matchScore: Math.round(score * 100),
      confidence: confidenceFromScore(score),
      profileId: id || undefined,
      profileUrl: id ? `${input.webBaseUrl.replace(/\/+$/u, "")}/entities/${id}/` : undefined,
      summary: summarizeEntity(entity),
      rawMetadataSafe: {
        datasets: Array.isArray(entity.datasets) ? entity.datasets : [],
        topics,
        score,
        schema: String(entity.schema ?? ""),
        firstSeen: String(entity.first_seen ?? ""),
        lastSeen: String(entity.last_seen ?? ""),
      },
      reviewStatus: "PENDING",
    });
  }

  // Сильнейшее совпадение первым: аналитик начинает сверку с него.
  return hits.sort((a, b) => b.matchScore - a.matchScore);
}

/**
 * Достаёт список сущностей из ответа.
 *
 * Пакетный матчинг отвечает `{responses: {<queryId>: {results: [...]}}}`,
 * поиск — `{results: [...]}`. Поддержаны обе формы: одна и та же функция
 * разбирает ответ и облачного сервиса, и самостоятельно поднятого `yente`.
 */
function extractResults(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;

  const responses = root.responses;
  if (responses && typeof responses === "object") {
    const collected: Array<Record<string, unknown>> = [];
    for (const value of Object.values(responses as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const results = (value as Record<string, unknown>).results;
      if (Array.isArray(results)) {
        collected.push(...results.filter(isEntityObject));
      }
    }
    return collected;
  }

  if (Array.isArray(root.results)) return root.results.filter(isEntityObject);
  return [];
}

function isEntityObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
