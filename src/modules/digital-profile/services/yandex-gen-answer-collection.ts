/**
 * Нейро-ответ Яндекса — поверхность базового сбора (шаг AO).
 *
 * Один вызов официального `POST /v2/gen/search` на прогон, контур RU, запрос —
 * первый субъектный запрос RU-плана. Ответ и названные Яндексом источники
 * ложатся строками `dp_search_surface_items` типа `AI_ANSWER` по образцу
 * арсенкинского `ai-serp`; исход попытки возвращается записью и живёт в
 * `base-collection-manifest.json`.
 *
 * Правило продукта здесь одно и оно жёсткое: генеративный ответ — это «вот что
 * поисковик отвечает о субъекте», а не факт о человеке. Поэтому текст едет
 * наблюдением с источниками, а подпись на слайде называет способ получения.
 */

import { createHash } from "node:crypto";
import { loadCaseSubject, type CaseSubjectInfo } from "../agents/mock/mock-utils";
import { providerConfig, serpCollectionMode } from "../providers/config";
import {
  fetchYandexGenAnswer,
  type YandexGenAnswerOutcome,
} from "../providers/yandex-search-provider";
import { YANDEX_GEN_ANSWER_URL_SCHEME } from "../providers/yandex-gen-search";
import { parseSubjectName } from "../risk-classifier/entity-disambiguation";
import {
  buildOrionQueryPlanDetailed,
  queriesForRegionPurpose,
} from "../search-surfaces/orion-query-plan";
import { buildSubjectQuerySet, plannedPrimaryQueries } from "../search-surfaces/subject-query-set";
import type { SearchSurfaceInput } from "../search-surfaces/types";
import { createManySearchSurfaceItems } from "./search-surface-service";
import type { YandexGenAnswerProbe } from "./unified-collection-types";

/**
 * Титул строки-тела: им страница называет ответ, поэтому он стабилен и не
 * зависит от текста. Ключом дедупликации титул **не** является — им служит
 * адрес (`surfaceDedupHash` берёт титул только у строк без адреса).
 */
function answerBodyTitle(query: string): string {
  return `Нейро-ответ Яндекса (официальный API): ${query}`;
}

/**
 * Синтетический адрес строки — он и есть ключ дедупликации
 * (`тип|источник|url`), поэтому у тела и у маркеров он обязан быть **разным**:
 * общий адрес означал бы, что `createMany({skipDuplicates})` молча выбросит
 * ответ, пришедший после пустоты, и страница напечатает «не найден» при
 * собранном ответе.
 *
 * У тела в ключ входит и сам текст: изменившийся ответ — это новое наблюдение,
 * а повторный сбор того же ответа второй строки не рождает.
 */
function genAnswerUrl(kind: "answer" | "empty" | "rejected", parts: string[]): string {
  const hash = createHash("sha1").update(["yandex-gen", kind, ...parts].join("|")).digest("hex").slice(0, 12);
  return `${YANDEX_GEN_ANSWER_URL_SCHEME}${kind}/${hash}`;
}

/**
 * Запрос, по которому спрашиваем нейро-ответ.
 *
 * Выводится тем же построителем, что и план сбора, поэтому совпадает с первым
 * субъектным запросом RU-контура. Автодополнение (сетевое) не спрашиваем: на
 * первый запрос набора оно не влияет — им всегда становится имя субъекта.
 * Читать запрос из `dp_search_queries` нельзя: `createMany` не гарантирует
 * порядок выборки.
 */
export function yandexGenAnswerQuery(
  subject: Pick<CaseSubjectInfo, "fullName" | "aliases" | "targetRegions" | "location">
): string | null {
  const parsed = parseSubjectName(subject.fullName);
  const set = buildSubjectQuerySet({
    profile: {
      fullName: subject.fullName,
      firstName: parsed.givenName ?? undefined,
      lastName: parsed.surname ?? undefined,
      patronymic: parsed.patronymic ?? undefined,
      variants: subject.aliases ?? [],
    },
    suggestions: [],
    region: "RU",
    language: "ru",
    capturedAt: new Date(0).toISOString(),
  });
  const { plan } = buildOrionQueryPlanDetailed(
    {
      fullName: subject.fullName,
      aliases: subject.aliases,
      targetRegions: subject.targetRegions,
      location: subject.location,
    },
    {
      primaryQueriesByRegion: { RU: plannedPrimaryQueries(set) },
      maxPrimaryPerRegion: providerConfig.orion.maxPrimaryQueriesPerRegion,
      regions: ["RU"],
    }
  );
  return queriesForRegionPurpose(plan, "RU", ["subject_lookup"])[0]?.query ?? null;
}

const BASE_ROW = {
  type: "AI_ANSWER",
  source: "REAL_YANDEX",
  provider: "YANDEX",
  region: "RU",
  language: "ru",
} as const satisfies Partial<SearchSurfaceInput>;

/**
 * Строки наблюдений по исходу вызова.
 *
 * Сбой и ненастроенный провайдер строк не дают вовсе: сбой — это не измерение,
 * и наблюдением он быть не может. Их место — запись о попытке.
 */
export function yandexGenAnswerRows(input: {
  query: string;
  outcome: YandexGenAnswerOutcome;
}): SearchSurfaceInput[] {
  const { query, outcome } = input;
  if (outcome.status === "FAILED" || outcome.status === "NOT_CONFIGURED") return [];

  const marker = (title: string, snippet: string): SearchSurfaceInput => ({
    ...BASE_ROW,
    query,
    title,
    snippet,
    url: genAnswerUrl(outcome.status === "REJECTED" ? "rejected" : "empty", [query]),
    domain: "yandex-gen",
    rank: 1,
    rawMetadata: {
      source: "yandex",
      method: "gen-search",
      contentKind: outcome.status === "REJECTED" ? "answer_rejected" : "absent",
      raw: outcome.answer.raw,
    },
  });

  if (outcome.status === "REJECTED") {
    return [
      marker(
        "Нейро-ответ Яндекса: ответ не предоставлен — модель Яндекса отказалась отвечать на запрос (этические ограничения)",
        "Запрос поисковику отправлен, генеративный ответ по нему не выдан: сработали этические ограничения модели. Это результат проверки, а не отсутствие сбора."
      ),
    ];
  }
  if (outcome.status === "NO_RESULTS") {
    return [
      marker(
        "Нейро-ответ Яндекса: не найден",
        "Запрос поисковику отправлен, генеративного ответа по нему нет. Это результат проверки, а не отсутствие сбора."
      ),
    ];
  }

  const answer = outcome.answer;
  const rows: SearchSurfaceInput[] = [
    {
      ...BASE_ROW,
      query,
      title: answerBodyTitle(query),
      // Полный текст, без среза: страница печатает ответ целиком.
      snippet: answer.answerText,
      url: genAnswerUrl("answer", [query, answer.answerText]),
      domain: "yandex-gen",
      rank: 1,
      rawMetadata: {
        source: "yandex",
        method: "gen-search",
        contentKind: "answer_text",
        isBulletAnswer: answer.isBulletAnswer,
        fixedMisspellQuery: answer.fixedMisspellQuery,
        searchQueries: answer.searchQueries,
        // Сырой ответ — evidence-first: по нему форма REST-стрима снимается с
        // живого прогона и фикстуры парсера пере-закрепляются.
        raw: answer.raw,
      },
    },
  ];
  // Все названные источники, без потолка: обрезка списка молча теряла бы то,
  // на что ответ ссылается, а число источников ограничивает сам ответ.
  answer.sources.forEach((src, i) => {
    rows.push({
      ...BASE_ROW,
      query,
      title: src.title ?? src.url,
      url: src.url,
      rank: i + 2,
      rawMetadata: {
        source: "yandex",
        method: "gen-search",
        contentKind: "answer_source",
        used: src.used,
      },
    });
  });
  return rows;
}

export type YandexGenAnswerCollectionInput = {
  caseId: string;
  /** Инъекции для офлайн-тестов; по умолчанию — живой субъект, провайдер и запись. */
  loadSubject?: (caseId: string) => Promise<CaseSubjectInfo>;
  fetchAnswer?: (query: string) => Promise<YandexGenAnswerOutcome>;
  saveRows?: (caseId: string, rows: SearchSurfaceInput[]) => Promise<number>;
};

/**
 * Спросить нейро-ответ и записать его наблюдениями. Возвращает запись о
 * попытке; исключений наружу не отдаёт — отказ источника не обнуляет
 * оплаченную работу базового сбора.
 */
export async function collectYandexGenAnswer(
  input: YandexGenAnswerCollectionInput
): Promise<YandexGenAnswerProbe> {
  const attemptedAt = new Date().toISOString();
  const fail = (errorCode: string, message: string, query: string | null): YandexGenAnswerProbe => ({
    status: "FAILED",
    query,
    errorCode,
    message,
    attemptedAt,
  });

  /*
   * В режиме `topvisor` генеративный ответ приходит снимком Topvisor, и
   * официальный `/v2/gen/search` не спрашивается: два источника одного ответа
   * — два ответа на один вопрос и двойная оплата. Исход записывается словом,
   * а не отсутствием записи.
   */
  if (serpCollectionMode() === "topvisor") {
    return {
      status: "SKIPPED_DELEGATED",
      query: null,
      errorCode: null,
      message: "Генеративный ответ собирает Topvisor (SERP_COLLECTION_PROVIDER=topvisor).",
      attemptedAt,
    };
  }

  let query: string | null = null;
  try {
    const subject = await (input.loadSubject ?? loadCaseSubject)(input.caseId);
    query = yandexGenAnswerQuery(subject);
    if (!query) {
      return fail("SUBJECT_QUERY_EMPTY", "Субъектный запрос RU-контура не построен.", null);
    }
    const outcome = await (input.fetchAnswer ?? fetchYandexGenAnswer)(query);
    const rows = yandexGenAnswerRows({ query, outcome });
    if (rows.length > 0) {
      const save =
        input.saveRows ??
        (async (caseId: string, items: SearchSurfaceInput[]) =>
          (await createManySearchSurfaceItems(caseId, items, { actorId: "real:YANDEX_GEN_ANSWER" }))
            .created);
      await save(input.caseId, rows);
    }
    return {
      status: outcome.status,
      query,
      errorCode: outcome.status === "FAILED" || outcome.status === "NOT_CONFIGURED"
        ? outcome.errorCode
        : null,
      message:
        outcome.status === "FAILED" || outcome.status === "NOT_CONFIGURED"
          ? outcome.message
          : null,
      attemptedAt,
    };
  } catch (err) {
    return fail(
      "PROVIDER_REQUEST_FAILED",
      err instanceof Error ? err.message : String(err),
      query
    );
  }
}
