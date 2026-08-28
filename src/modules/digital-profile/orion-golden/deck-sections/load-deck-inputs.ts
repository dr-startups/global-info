/**
 * Subject-agnostic deck-input loader.
 *
 * Reads a canonical analytics artifact directory (produced by
 * `runOrionAnalyticsPipeline`) and derives the inputs `runDeckBuild` needs.
 * Contains NO subject-specific literals and NO baseline (report-72) paths — it
 * works for any subject whose analytics artifacts live in `analyticsDir`.
 *
 * This is the canonical, universal counterpart of the report-72 replay loader.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { Finding } from "../contracts/finding";
import type { SurfaceAnalysis } from "../contracts/surface-analysis";
import type {
  ScopedEvidenceIndex,
  LinkReadRegionCounts,
  MetricSnapshot,
  SurfaceCollectionHint,
  ComplianceScreeningRecord,
  PersonaDecisionRecord,
} from "./scoped-input";
import {
  clientNamedSearchEngine,
  evidenceMaterialKey,
  normalizeCoverageSurface,
  PERSONA_DECISION_ARTIFACT,
} from "./scoped-input";
import { normalizeSourceType } from "../analytics/source-type";
import type { AppliedOverrideRecord } from "../../services/analyst-overrides-loader";
import {
  verdictStrength,
  type AnalystDecision,
  type ObservationVerdict,
} from "../../serp-observation/resolve-observation-highlights";
import { pageQuoteForClient } from "../analytics/client-quote-hygiene";
import type { LinkReadingReport } from "../analytics/link-reading-agent";
import { mapRegionBucket } from "../classic/composite-serp-overlay-merge";
import { wikipediaCheckInventoryId } from "../../services/evidence-supplement-adapter";
import { WIKIPEDIA_ARTICLE_REVIEW_ARTIFACT } from "../analytics/run-wikipedia-article-review";
import { WikipediaArticleReviewSetSchema } from "../contracts/wikipedia-article-review";

export type CompositeObservationRow = {
  observationKey?: string;
  surface: string;
  region: string;
  engine?: string;
  url?: string;
  title?: string;
  /** Текст наблюдения — есть у ответов ИИ-поиска, которые страница печатает целиком. */
  snippet?: string;
  /** Кто добыл наблюдение (`yandex` / `serper` / `arsenkin`). */
  provider?: string;
  domain?: string;
  /** Позиция в выдаче, если поисковик её сообщил. */
  rank?: number;
  /** Чья позиция записана в `rank` (yandex / serper / arsenkin / unknown). */
  rankSource?: string;
  /** Запрос, по которому материал показался, и его назначение из плана. */
  query?: string;
  queryPurpose?: string;
  evidenceRefs: string[];
};

/** Higher wins when an observation has multiple inventory decisions (§KPI honesty). */
const DECISION_RANK: Record<string, number> = {
  SUBJECT_MATCH: 4,
  LIKELY_SUBJECT: 3,
  AMBIGUOUS: 2,
  OTHER_SUBJECT: 1,
  INSUFFICIENT_IDENTIFIERS: 0,
};

/** Pick the strongest identity decision among linked evidence refs. */
export function bestIdentityDecision(
  refs: string[],
  decisionByRef: Map<string, string>
): string | undefined {
  let best: string | undefined;
  for (const ref of refs) {
    const d = decisionByRef.get(ref);
    if (!d) continue;
    if (!best || (DECISION_RANK[d] ?? -1) > (DECISION_RANK[best] ?? -1)) best = d;
  }
  return best;
}

/**
 * Client KPI identity counts — one bucket per composite observation row, not
 * per inventory item. Prevents «О субъекте» > «Материалов» when duplicates
 * collapse into a single observation.
 */
export function countIdentityByObservation(input: {
  observationRefGroups: string[][];
  decisionByRef: Map<string, string>;
}): {
  subjectMatchCount: number;
  likelySubjectCount: number;
  ambiguousCount: number;
  otherSubjectCount: number;
  /** Нет признаков субъекта вовсе — и нет решения по наблюдению. */
  insufficientCount: number;
} {
  let subjectMatchCount = 0;
  let likelySubjectCount = 0;
  let ambiguousCount = 0;
  let otherSubjectCount = 0;
  // Классификатор возвращает пять решений, а считались четыре: наблюдения с
  // `INSUFFICIENT_IDENTIFIERS` (и вовсе без решения) не попадали никуда, и
  // плитки на обложке не сходились — 504 материала против 473 в разбивке
  // (шаг 13, C10). Разбивка обязана быть полной.
  let insufficientCount = 0;
  for (const refs of input.observationRefGroups) {
    const best = bestIdentityDecision(refs, input.decisionByRef);
    if (best === "SUBJECT_MATCH") subjectMatchCount += 1;
    else if (best === "LIKELY_SUBJECT") likelySubjectCount += 1;
    else if (best === "AMBIGUOUS") ambiguousCount += 1;
    else if (best === "OTHER_SUBJECT") otherSubjectCount += 1;
    else insufficientCount += 1;
  }
  return {
    subjectMatchCount,
    likelySubjectCount,
    ambiguousCount,
    otherSubjectCount,
    insufficientCount,
  };
}

/**
 * Прочитано и негативно — по региональным контурам, по уникальным страницам.
 *
 * Считается по строкам вердиктов, а не по индексу наблюдений: флаг `adverse` в
 * индексе взводится и для страниц с вероятной принадлежностью, а
 * `readVerdictTone` о принадлежности не знает вовсе. Точный предикат «эта
 * страница прочитана, она о субъекте и она нежелательна» есть только у самого
 * вердикта — «упрощение» до скана индекса разведёт числитель со страницей тем.
 *
 * «Прочитано» задаётся данными: пустой `readFailure`. Вердикт непрочитанной
 * страницы — честное «не знаем», а не оценка, и в долю не входит.
 *
 * Одна ссылка считается один раз: инвариант «страница входит ровно в одну
 * тему» живёт в кластеризации тем, и метрика региона не должна от него
 * зависеть. Корзины — те же `RU`/`UAE`, что и у тем: вердикт без региона и
 * вердикт чужого контура в региональные числа не попадают, ровно как их темы
 * не попадают в региональную таблицу тем.
 */
export function countLinkReadByRegion(
  verdicts: LinkVerdictRow[]
): Record<string, LinkReadRegionCounts> {
  const counts: Record<string, LinkReadRegionCounts> = {};
  const seen = new Set<string>();
  for (const v of verdicts) {
    const ref = String(v.evidenceRef ?? "").trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    if (!v.region) continue;
    const bucket = mapRegionBucket(v.region);
    if (bucket !== "RU" && bucket !== "UAE") continue;
    const row = (counts[bucket] ??= { requested: 0, read: 0, readOther: 0, adverseRead: 0 });
    row.requested += 1;
    if (v.readFailure) continue;
    row.read += 1;
    if (v.subjectMatch === "other") row.readOther += 1;
    else if (v.subjectMatch === "subject" && v.tone === "adverse") row.adverseRead += 1;
  }
  return counts;
}

/** Решение по одной прочитанной ссылке — так, как его пишет агент чтения. */
export type LinkVerdictRow = {
  evidenceRef?: string;
  region?: string;
  subjectMatch?: string;
  tone?: string;
  theme?: string;
  sourceType?: string;
  quotes?: Array<{ text?: string }>;
  /** Заполнено — страницу прочитать не удалось; решения по ней нет. */
  readFailure?: string;
};

/**
 * Ссылки индекса, сгруппированные по материалу.
 *
 * Материал опознаётся адресом, а не одним заголовком, и правило это одно на
 * весь слой деки (`evidenceMaterialKey`): и решение по прочитанной странице, и
 * решение аналитика раскладываются по тем же материалам, по которым
 * региональный блок темы считает «Всего по теме». Помощник общий, чтобы в одном
 * файле не оказалось двух одинаковых циклов над ключом материала.
 */
function refsByMaterial(evidenceIndex: ScopedEvidenceIndex): Map<string, string[]> {
  const byKey = new Map<string, string[]>();
  for (const ref of Object.keys(evidenceIndex)) {
    const key = evidenceMaterialKey(evidenceIndex[ref], ref);
    const list = byKey.get(key);
    if (list) list.push(ref);
    else byKey.set(key, [ref]);
  }
  return byKey;
}

/**
 * Разложить явные решения аналитика на индекс доказательств.
 *
 * Решение принадлежит материалу, а не наблюдению, — по той же причине, что и
 * решение по прочитанной странице: ключ наблюдения включает запрос, одна
 * страница по двум запросам лежит в индексе двумя ссылками, а потребители
 * спрашивают `some(...)` по ссылкам материала. Без раскладки «нежелательный»
 * сработал бы, а «нейтральный» — нет: одна непомеченная ссылка вернула бы
 * `true`, и «или» перекрыло бы решение человека.
 *
 * Цена раскладки та же, что уже принята для вердикта: ключ — «домен и
 * заголовок», и две разные страницы одного сайта с одинаковым заголовком делят
 * решение. Третий ответ на «тот же ли это материал» заводить ради этого нельзя.
 *
 * `identity_other_subject` и `manual_review_wrong_subject` сюда **не**
 * отображаются: это ответ о принадлежности, он едет своим путём
 * (`subject-resolution.json` → `subjectDecision`), и дублировать его вторым
 * полем значит заводить второй ответ. `approved_finding` — решение о находке,
 * а не о строке.
 */
export function applyAnalystDecisionsToEvidence(
  evidenceIndex: ScopedEvidenceIndex,
  applied: AppliedOverrideRecord[]
): void {
  const decisionOf = (kind: string): AnalystDecision | undefined => {
    if (kind === "classification_adverse") return "ADVERSE";
    // «Снято при ручной проверке» — тот же `markNeutral` в источнике правок.
    if (kind === "classification_neutral" || kind === "manual_review_excluded") return "NEUTRAL";
    return undefined;
  };
  const byMaterial = refsByMaterial(evidenceIndex);
  for (const record of applied) {
    const decision = decisionOf(String(record?.kind ?? ""));
    if (!decision) continue;
    const inventoryId = String(record?.inventoryId ?? "").trim();
    if (!inventoryId) continue;
    const ref = `inventory:${inventoryId}`;
    const entry = evidenceIndex[ref];
    if (!entry) continue;
    for (const sibling of byMaterial.get(evidenceMaterialKey(entry, ref)) ?? [ref]) {
      evidenceIndex[sibling]!.analystDecision = decision;
    }
  }
}

/**
 * Разложить решения по прочитанным страницам на индекс доказательств.
 *
 * **Решение принадлежит материалу, а не наблюдению.** Ключ наблюдения включает
 * запрос, поэтому одна страница, найденная двумя запросами, — две ссылки, и
 * читают её один раз. На отчёте Кремлёва `opensanctions.org/entities/Q55102113`
 * был прочитан и признан нежелательным с тремя цитатами, но решение легло на
 * ссылку RU-запроса, а строка таблицы ОАЭ собрана из своих одиннадцати ссылок —
 * и напечаталась «Нейтральной» при красной рамке на том же адресе двумя листами
 * дальше. Поэтому решение раскладывается по всем ссылкам своего материала —
 * тем же ключом, каким сводит строки таблица выдачи.
 *
 * Решение по прочитанной странице сильнее заголовка выдачи: оценка ставилась по
 * словам «суд», «санкции», «арест», и телеинтервью 2015 года получало метку
 * «Нежелательный», а страница санкционного списка без этих слов — «Нейтральный».
 * Материал, признанный чужим («это однофамилец»), перестаёт быть подтверждением
 * чего-либо о субъекте.
 */
export function applyLinkVerdictsToEvidence(
  evidenceIndex: ScopedEvidenceIndex,
  verdicts: LinkVerdictRow[]
): void {
  const materialRefs = refsByMaterial(evidenceIndex);
  /*
   * Один материал — одно решение, и оно сильнейшее.
   *
   * Само правило живёт рядом с предикатом (`verdictStrength`): по нему выбирает
   * решение и раскладка карты решений в аналитике. Здесь к нему добавлено
   * только «отказ чтения решения не приносит» — у строки артефакта, в отличие
   * от готового решения, отказ ещё может стоять.
   */
  const strength = (v: LinkVerdictRow): number => {
    if (v.readFailure) return 0;
    return verdictStrength({
      tone: (v.tone as ObservationVerdict["tone"]) ?? "neutral",
      quoted: (v.quotes ?? []).some((q) => String(q?.text ?? "").trim().length > 0),
      subjectMatch: "unclear",
    });
  };
  const chosen = new Map<string, LinkVerdictRow>();
  for (const v of verdicts) {
    const ref = String(v.evidenceRef ?? "");
    if (!ref || !evidenceIndex[ref]) continue;
    const key = evidenceMaterialKey(evidenceIndex[ref], ref);
    const prev = chosen.get(key);
    if (!prev || strength(v) > strength(prev)) chosen.set(key, v);
  }
  for (const [key, v] of chosen) {
    const ownUrl = normalizedAddress(evidenceIndex[String(v.evidenceRef)]?.url);
    for (const ref of materialRefs.get(key) ?? []) {
      /*
       * Оценка принадлежит материалу, дословная цитата — прочитанной странице.
       *
       * Ключ материала адреса не читает, поэтому в одну группу законно
       * попадают разные адреса (тот же материал с трекинг-параметром) — а
       * могут попасть и две разные страницы с одинаковым заголовком. Оценку
       * они делят, цитату нет: утверждение обязано прослеживаться до
       * наблюдения со своим URL.
       */
      const sameAddress = normalizedAddress(evidenceIndex[ref]?.url) === ownUrl;
      applyLinkVerdictToEntry(evidenceIndex[ref]!, v, sameAddress);
    }
  }
}

/** Адрес без трекинг-хвоста и якоря — для сравнения «та же это страница или нет». */
function normalizedAddress(url: string | undefined): string {
  return String(url ?? "")
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/u, "")
    .replace(/\/+$/u, "");
}

/** Одно решение — на одну запись индекса; цитата едет только на свой адрес. */
function applyLinkVerdictToEntry(
  entry: ScopedEvidenceIndex[string],
  v: LinkVerdictRow,
  carryQuote: boolean
): void {
  /*
   * Непрочитанная страница решения не приносит.
   *
   * Страницу не открыли — модель честно отвечает «не знаем»: `unclear`,
   * `neutral`, темой становится заголовок выдачи. Применённый наравне с
   * настоящим, такой вердикт гасил словарную метку «Нежелательный» и писал
   * `readVerdictTone`, по которому потребители отличают прочитанную страницу
   * от непрочитанной. Про заблокированную страницу словарь — всё, что есть.
   */
  if (v.readFailure) {
    // Причина непрочтения — тоже результат: страница отчёта объясняет ею
    // рамку, поставленную по заголовку выдачи, вместо молчаливого «уровень».
    entry.readFailure = String(v.readFailure);
    return;
  }
  const quoted = (v.quotes ?? []).some((q) => String(q?.text ?? "").trim().length > 0);
  if (v.tone === "adverse" && quoted) entry.adverse = true;
  if (v.tone === "supportive" || v.tone === "neutral") entry.adverse = false;
  if (v.subjectMatch === "other") {
    entry.adverse = false;
    entry.subjectDecision = "OTHER_SUBJECT";
  }
  // Принадлежность по прочтению запоминается как есть: фраза «Почему
  // выделено» обязана оговорить вероятную принадлежность, а не выдать её за
  // подтверждённую.
  if (v.subjectMatch) entry.verdictSubjectMatch = String(v.subjectMatch);
  // Тип источника определён по самой странице — он сильнее догадки по домену.
  const sourceType = normalizeSourceType(v.sourceType);
  if (sourceType) entry.sourceType = sourceType;
  // Тон прочитанной страницы запоминается отдельно: по нему темы повышенного
  // внимания отбирают, что можно цитировать. Словарь ключевых слов работает
  // по заголовку и о содержимом страницы не знает.
  if (v.tone === "adverse" || v.tone === "neutral" || v.tone === "supportive") {
    entry.readVerdictTone = v.tone;
  }
  // «О чём публикация» одной русской фразой — из решения по прочитанной
  // странице. Иноязычная цитата печатается дословно, а эта строка идёт рядом.
  const theme = String(v.theme ?? "").trim();
  if (theme) entry.verdictTheme = theme;
  // Первая годная цитата со страницы: она и станет цитатой в отчёте вместо
  // обрезанного заголовка выдачи.
  if (!carryQuote) return;
  for (const q of v.quotes ?? []) {
    const quote = pageQuoteForClient(q?.text);
    if (quote) {
      entry.pageQuote = quote;
      break;
    }
  }
}

export type UncategorizedMaterialsDeckInput = {
  count: number;
  byRegion: Record<
    string,
    {
      count: number;
      examples: Array<{ title: string; evidenceRef: string; domain?: string }>;
    }
  >;
};

export type CanonicalDeckInputs = {
  caseId: string;
  reportRunId: string;
  sourceDatasetId: string;
  mergedBundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysis["units"];
  evidenceIndex: ScopedEvidenceIndex;
  knownEvidenceRefs: Set<string>;
  metricSnapshot: MetricSnapshot;
  executiveSummary: Record<string, unknown>;
  /** Stage 5/6 — optional; when present, executive SectionPack uses semantic pagination. */
  composedClientSummary: Record<string, unknown> | null;
  subjectResolution: { items: Array<{ decision: string }> };
  baseCountBefore: number;
  baseCountAfter: number;
  /** REMEDIATION §3.2 — optional; absent on older analytics dirs. */
  uncategorizedMaterials: UncategorizedMaterialsDeckInput | null;
  /** REMEDIATION §7.4 — coverage cells for empty-state copy (optional). */
  surfaceCollectionHints: SurfaceCollectionHint[];
  /** Последний ран скрининга по каждой базе; пусто — проверок в прогоне не было. */
  complianceScreenings: ComplianceScreeningRecord[];
  /** Решение оператора о персоне субъекта; null — решения у кейса нет. */
  personaDecision: PersonaDecisionRecord | null;
  /**
   * Строки наблюдений как есть, до сборки индекса доказательств.
   *
   * Ими ворота сборки сверяют напечатанную таблицу выдачи: мерить её тем же
   * индексом, которым она собрана, бессмысленно — сломанный тракт согласится
   * сам с собой.
   */
  serpObservations: CompositeObservationRow[];
};

/**
 * «Проверено, ИИ-ответа нет» вместо «поверхность не собиралась».
 *
 * Готовый ответ и панель знаний приходят тем же ответом Google, что и
 * органика: если по региону есть строки органики Google, ответ провайдера был
 * получен и разобран. Значит, отсутствие ИИ-блока — это результат проверки, а
 * не пропущенный сбор, и страница отчёта обязана говорить именно так: разница
 * между «не смотрели» и «смотрели, пусто» — это разница между дырой в
 * покрытии и фактом.
 *
 * Подсказка не выдумывается там, где сбор действительно не удался: если о
 * поверхности уже есть запись о статусе, она сильнее выведенной.
 */
export function googleAnswerProbeHints(
  observations: Array<{ surface: string; region: string; engine?: string }>,
  existing: SurfaceCollectionHint[]
): SurfaceCollectionHint[] {
  const isGoogle = (engine?: string): boolean => /GOOGLE|SERPER/iu.test(String(engine ?? ""));
  // Заслонить выведенный факт может только запись, про которую известно, что
  // она о Google, либо запись без движка вовсе (движок неизвестен — считаем,
  // что она может быть о нём). Ответ, у которого движок назван и он другой,
  // факта про Google не отменяет.
  const notOtherEngine = (engine?: string): boolean =>
    !String(engine ?? "").trim() || isGoogle(engine);
  const probedRegions = new Set<string>();
  const answeredRegions = new Set<string>();
  for (const o of observations) {
    const region = mapRegionBucket(o.region);
    if (!region) continue;
    const surface = normalizeCoverageSurface(o.surface);
    if (surface === "organic" && isGoogle(o.engine)) probedRegions.add(region);
    // Отвеченность считается по-движково: нейро-ответ Яндекса не отменяет
    // факта «Google спрошен, готового ответа в его выдаче нет».
    if (surface === "ai_answers" && notOtherEngine(o.engine)) answeredRegions.add(region);
  }
  // Заслоняет выведенный факт только запись о **состоявшейся** попытке —
  // измерение или сбой. Ячейка «не спрашивали» (выключенный инструмент по
  // другой поисковой системе) его не глушит: иначе честность по одному движку
  // покупалась бы потерей измеренного факта по другому.
  const alreadyKnown = new Set(
    existing
      .filter(
        (h) =>
          normalizeCoverageSurface(h.surface) === "ai_answers" &&
          notOtherEngine(h.engine) &&
          !/^(NOT_COLLECTED|DISABLED)$/i.test(String(h.status ?? ""))
      )
      .map((h) => mapRegionBucket(h.region ?? ""))
  );
  return [...probedRegions]
    .filter((region) => !answeredRegions.has(region) && !alreadyKnown.has(region))
    .sort()
    .map((region) => ({
      surface: "ai_answers",
      region,
      status: "NO_RESULTS",
      errorCode: null,
      provider: "GOOGLE",
      // Утверждение ограничено разобранной выдачей Google — движок назван,
      // чтобы страница не выдавала его за проверку нейро-ответов Яндекса.
      engine: "GOOGLE",
    }));
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

const RISK_ORDER: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Build the deterministic deck-build inputs from an analytics artifact dir.
 * Fail-closed: throws if a required artifact is missing/unreadable.
 */
export function loadDeckInputsFromAnalyticsDir(analyticsDir: string): CanonicalDeckInputs {
  const bundle = readJson<VerifiedFindingBundle>(join(analyticsDir, "verified-finding-bundle.json"));
  const ambiguous = readJson<Finding[]>(join(analyticsDir, "ambiguous-findings.json"));
  const surfaceAnalysis = readJson<Record<string, SurfaceAnalysis>>(
    join(analyticsDir, "surface-analysis.json")
  );
  const executiveSummary = readJson<Record<string, unknown>>(
    join(analyticsDir, "executive-summary.json")
  );
  const composedPath = join(analyticsDir, "composed-client-summary.json");
  const composedClientSummary = existsSync(composedPath)
    ? readJson<Record<string, unknown>>(composedPath)
    : null;
  const binding = readJson<{ baseReportRunId: string; datasetId: string; caseId: string }>(
    join(analyticsDir, "report-data-binding.json")
  );
  const providerDelta = readJson<{ baseCount: number; arsenkinObservationCount: number }>(
    join(analyticsDir, "provider-delta.json")
  );
  // Область анализа: сколько материалов вошло в предмет аудита (ТОП-20 плюс
  // международные базы). Артефакт появился позже самой колоды, поэтому его
  // отсутствие не валит сборку — страница тогда просто не называет это число,
  // а не печатает вместо него размер всего собранного корпуса.
  /*
   * Решения по прочитанным ссылкам.
   *
   * Оценка материала в таблице выдачи до сих пор ставилась по заголовку: если
   * в нём попадались слова про суд или санкции — «Нежелательный». Так
   * телеинтервью 2015 года получило красную метку, а страница санкционного
   * списка без ключевых слов — зелёную. Решение, вынесенное по тексту
   * страницы, точнее заголовка и потому переопределяет его.
   *
   * Файла может не быть: чтение ссылок выключено по умолчанию, и старые
   * прогоны его не знают. Тогда всё работает как раньше.
   */
  const linkVerdictsPath = join(analyticsDir, "link-verdicts.json");
  const linkVerdicts = existsSync(linkVerdictsPath)
    ? readJson<{
        verdicts?: LinkVerdictRow[];
        summary?: {
          unread?: number;
          themes?: Array<{ theme?: string; count?: number; adverseCount?: number }>;
        };
        themesByRegion?: Record<
          string,
          Array<{ theme?: string; count?: number; adverseCount?: number }>
        >;
        reading?: {
          status?: string;
          requested?: number;
          read?: number;
          failed?: number;
          retried?: number;
          byReason?: Record<string, number>;
        };
      }>(linkVerdictsPath)
    : null;
  const themeRows = (
    rows: Array<{ theme?: string; count?: number; adverseCount?: number }> | undefined
  ) =>
    (rows ?? [])
      .filter((t) => typeof t.theme === "string" && t.theme.trim() && (t.count ?? 0) > 0)
      .map((t) => ({
        theme: String(t.theme).trim(),
        count: Number(t.count ?? 0),
        adverseCount: Number(t.adverseCount ?? 0),
      }));
  const linkThemesByRegion = Object.fromEntries(
    Object.entries(linkVerdicts?.themesByRegion ?? {}).map(([region, rows]) => [
      mapRegionBucket(region),
      themeRows(rows),
    ])
  );
  const linkThemes = (linkVerdicts?.summary?.themes ?? [])
    .filter((t) => typeof t.theme === "string" && t.theme.trim() && (t.count ?? 0) > 0)
    .map((t) => ({
      theme: String(t.theme).trim(),
      count: Number(t.count ?? 0),
      adverseCount: Number(t.adverseCount ?? 0),
    }));

  const analysisScopePath = join(analyticsDir, "analysis-scope.json");
  const analysisScope = existsSync(analysisScopePath)
    ? readJson<{
        analyzed?: number;
        topN?: number;
        lanes?: Array<{ lane?: string; analyzed?: number }>;
      }>(analysisScopePath)
    : null;
  const analysisLanes = (analysisScope?.lanes ?? [])
    .filter((l) => typeof l.analyzed === "number" && l.analyzed > 0 && typeof l.lane === "string")
    .map((l) => {
      const [engine = "", region = ""] = String(l.lane).split("|");
      return { engine, region, analyzed: l.analyzed as number };
    })
    .filter((l) => l.engine && l.region);
  const observations = readJson<{
    observations: CompositeObservationRow[];
    baseCount: number;
    compositeCount: number;
  }>(join(analyticsDir, "composite-serp-observations.json"));
  const subjectResolution = readJson<{
    items: Array<{ evidenceRef?: string; decision: string }>;
  }>(join(analyticsDir, "subject-resolution.json"));

  const decisionByRef = new Map(
    (subjectResolution.items ?? [])
      .filter((i) => i.evidenceRef)
      .map((i) => [i.evidenceRef!, i.decision] as const)
  );

  // Provenance keeps inventory: refs even when observation.evidenceRefs use
  // serp_observation: / databaseProfile: keys — required for honest KPI join.
  const provenancePath = join(analyticsDir, "composite-serp-provenance.json");
  let observationRefGroups: string[][] = observations.observations.map((o) => o.evidenceRefs ?? []);
  const provenanceByKey = new Map<string, string[]>();
  let surfaceCollectionHints: SurfaceCollectionHint[] = [];
  if (existsSync(provenancePath)) {
    try {
      const provenance = readJson<{
        entries?: Array<{ observationKey?: string; evidenceRefs?: string[] }>;
        nonOkCoverageCells?: Array<{
          region?: string;
          engine?: string;
          surface?: string;
          status?: string;
          errorCode?: string | null;
          provider?: string;
        }>;
      }>(provenancePath);
      for (const e of provenance.entries ?? []) {
        if (e.observationKey) provenanceByKey.set(e.observationKey, e.evidenceRefs ?? []);
      }
      if (provenanceByKey.size > 0) {
        observationRefGroups = observations.observations.map((o) => {
          const fromProv = o.observationKey ? provenanceByKey.get(o.observationKey) : undefined;
          return fromProv && fromProv.length > 0 ? fromProv : (o.evidenceRefs ?? []);
        });
      }
      surfaceCollectionHints = (provenance.nonOkCoverageCells ?? [])
        .filter((c) => c.surface && c.status)
        .map((c) => ({
          surface: String(c.surface),
          region: c.region ? mapRegionBucket(c.region) : undefined,
          // Поисковая система нужна пустому состоянию: «проверено» печатается
          // только про ту, которую действительно спрашивали.
          engine: clientNamedSearchEngine(c.engine) ?? undefined,
          status: String(c.status),
          errorCode: c.errorCode ?? null,
          provider: c.provider,
        }));
    } catch {
      // non-fatal: fall back to observation evidenceRefs
    }
  }
  surfaceCollectionHints = [
    ...surfaceCollectionHints,
    ...googleAnswerProbeHints(observations.observations, surfaceCollectionHints),
  ];

  const identityCounts = countIdentityByObservation({
    observationRefGroups,
    decisionByRef,
  });

  const mergedBundle: VerifiedFindingBundle = {
    ...bundle,
    findings: [...bundle.findings, ...ambiguous],
  };
  const surfaceUnits = Object.values(surfaceAnalysis).flatMap((sa) => sa.units);

  const evidenceIndex: ScopedEvidenceIndex = {};
  const knownEvidenceRefs = new Set<string>();
  const perRegionCounts: Record<string, number> = {};
  // Разбивка «вероятно о субъекте» по регионам. Раньше на региональную
  // страницу печаталось глобальное число, из-за чего у России (312 материалов)
  // и ОАЭ (192) стояло одно и то же «31» (шаг 13, C10).
  const perRegionLikelyCounts: Record<string, number> = {};
  for (let i = 0; i < observations.observations.length; i += 1) {
    const obs = observations.observations[i]!;
    const regionKey = mapRegionBucket(obs.region) === "UAE" ? "UAE" : "RU";
    perRegionCounts[regionKey] = (perRegionCounts[regionKey] ?? 0) + 1;
    const linkedRefs = observationRefGroups[i] ?? obs.evidenceRefs ?? [];
    const subjectDecision = bestIdentityDecision(linkedRefs, decisionByRef);
    if (subjectDecision === "LIKELY_SUBJECT") {
      perRegionLikelyCounts[regionKey] = (perRegionLikelyCounts[regionKey] ?? 0) + 1;
    }
    const allRefs = [...new Set([...(obs.evidenceRefs ?? []), ...linkedRefs])];
    for (const ref of allRefs) {
      knownEvidenceRefs.add(ref);
      evidenceIndex[ref] = {
        ...(evidenceIndex[ref] ?? {}),
        url: obs.url,
        domain: obs.domain,
        title: obs.title,
        // Текст и его добытчик нужны там, где страница печатает само
        // наблюдение, а не ссылку на него: нейро-ответ поисковика — это его
        // текст, и подпись под ним обязана называть, чей это ответ.
        snippet: obs.snippet ?? evidenceIndex[ref]?.snippet,
        provider: obs.provider ?? evidenceIndex[ref]?.provider,
        kind: obs.surface,
        region: obs.region,
        engine: obs.engine,
        // Комплаенс-запись называет свою базу тем, что о ней известно
        // наблюдению: провайдер приходит в `engine`. Пока построитель читал
        // только обогащение из `compliance-inventory.json`, реплей прогона без
        // этого файла схлопывал три базы в одну безымянную строку, а страницы
        // Dow Jones и LexisNexis объявляли «записей не зафиксировано» при
        // фактических записях в этих базах.
        providerLabel:
          obs.surface === "compliance_hit"
            ? obs.engine ?? evidenceIndex[ref]?.providerLabel
            : evidenceIndex[ref]?.providerLabel,
        // Один материал встречается по нескольким запросам с разными
        // позициями; видимость определяет лучшая из них.
        rank:
          typeof obs.rank === "number"
            ? Math.min(obs.rank, evidenceIndex[ref]?.rank ?? obs.rank)
            : evidenceIndex[ref]?.rank,
        // Источник позиции едет вместе с ней: таблица ТОП-20 печатает только
        // позиции родного поисковика, и без этого признака ей не отличить
        // нумерацию Яндекса от нумерации обогатителя.
        rankSource:
          typeof obs.rank === "number" &&
          obs.rank <= (evidenceIndex[ref]?.rank ?? Number.MAX_SAFE_INTEGER)
            ? obs.rankSource ?? evidenceIndex[ref]?.rankSource
            : evidenceIndex[ref]?.rankSource,
        // Запрос запоминается первый: материал мог показаться по нескольким,
        // и подпись колонки берётся у того, где он виден выше (строки идут в
        // порядке лучшей позиции).
        query: evidenceIndex[ref]?.query ?? obs.query,
        queryPurpose: evidenceIndex[ref]?.queryPurpose ?? obs.queryPurpose,
        subjectDecision: subjectDecision ?? decisionByRef.get(ref) ?? evidenceIndex[ref]?.subjectDecision,
      };
    }
  }

  applyLinkVerdictsToEvidence(evidenceIndex, linkVerdicts?.verdicts ?? []);
  /*
   * Явные решения аналитика по материалам.
   *
   * Файл пишет конвейер аналитики, когда правки были; его может не быть вовсе
   * — реплей старого прогона, эталон `report-72`. Отсутствие файла **не
   * значит «все нейтральны»**: решений просто нет, и предикат работает как
   * раньше.
   */
  const analystAppliedPath = join(analyticsDir, "analyst-overrides-applied.json");
  if (existsSync(analystAppliedPath)) {
    const artifact = readJson<{ applied?: AppliedOverrideRecord[] }>(analystAppliedPath);
    applyAnalystDecisionsToEvidence(evidenceIndex, artifact?.applied ?? []);
  }

  // Enrich compliance_hit entries with typed match metadata (provider /
  // category / score / review / поля карточки) so p33–p36 tables are
  // evidence-backed.
  let complianceScreenings: ComplianceScreeningRecord[] = [];
  // Written by runCanonicalReportPrepare / analytics after the adapter runs.
  const complianceInventoryPath = join(analyticsDir, "compliance-inventory.json");
  if (existsSync(complianceInventoryPath)) {
    try {
      const inventory = readJson<{
        items?: Array<{
          inventoryId?: string;
          evidenceType?: string;
          title?: string;
          rawMetadata?: {
            provider?: string;
            matchType?: string;
            matchCategory?: string;
            matchedName?: string;
            matchScore?: number;
            reviewStatus?: string;
            aliases?: string[];
            countries?: string[];
            datesOfBirth?: string[];
            confidence?: string;
            profileId?: string;
            summary?: string;
            profileUrl?: string;
          };
        }>;
        screenings?: ComplianceScreeningRecord[];
      }>(complianceInventoryPath);
      for (const item of inventory.items ?? []) {
        if (item.evidenceType !== "compliance_hit" || !item.inventoryId) continue;
        const ref = `inventory:${item.inventoryId}`;
        const existing = evidenceIndex[ref] ?? {};
        const meta = item.rawMetadata ?? {};
        evidenceIndex[ref] = {
          ...existing,
          kind: "compliance_hit",
          title: item.title ?? existing.title,
          // Собственное имя записи — отдельно от заголовка инвентаря: в
          // `title` подстановка имени субъекта уже случилась, и по нему
          // «своё имя» от «имени субъекта» не отличить.
          matchedName: meta.matchedName ?? existing.matchedName,
          providerLabel: meta.provider ?? existing.providerLabel,
          matchCategory: meta.matchCategory ?? meta.matchType ?? existing.matchCategory,
          matchScore: meta.matchScore ?? existing.matchScore,
          reviewStatus: meta.reviewStatus ?? existing.reviewStatus,
          aliases: meta.aliases ?? existing.aliases,
          countries: meta.countries ?? existing.countries,
          datesOfBirth: meta.datesOfBirth ?? existing.datesOfBirth,
          confidence: meta.confidence ?? existing.confidence,
          profileId: meta.profileId ?? existing.profileId,
          summary: meta.summary ?? existing.summary,
          // Адрес карточки записи — это и есть URL данного доказательства;
          // второго поля под него заводить незачем.
          url: meta.profileUrl ?? existing.url,
        };
        knownEvidenceRefs.add(ref);
      }
      complianceScreenings = (inventory.screenings ?? []).filter((s) => Boolean(s?.provider));
    } catch {
      // Missing/unreadable enrichment is non-fatal; fragment falls back to titles.
    }
  }

  // §1.4 — WikipediaCheck (+ screenshot provenance refs) for identity / visuals.
  const supplementPath = join(analyticsDir, "evidence-supplement.json");
  if (existsSync(supplementPath)) {
    try {
      const supplement = readJson<{
        wikipediaChecks?: Array<{
          id?: string;
          exists?: boolean;
          url?: string | null;
          language?: string | null;
          pageTitle?: string | null;
          lastChecked?: string | null;
          query?: string | null;
          foundVia?: string | null;
          langlinkOf?: { language?: string | null; title?: string | null } | null;
        }>;
        serpScreenshots?: Array<{
          id?: string;
          region?: string;
          engine?: string | null;
          evidenceRefs?: string[];
        }>;
      }>(supplementPath);
      for (const w of supplement.wikipediaChecks ?? []) {
        if (!w.id) continue;
        const ref = `inventory:${wikipediaCheckInventoryId(w.id)}`;
        const existing = evidenceIndex[ref] ?? {};
        const lang = String(w.language ?? "").toLowerCase();
        evidenceIndex[ref] = {
          ...existing,
          kind: "wikipedia_check",
          title: w.pageTitle ?? existing.title,
          url: w.url ?? existing.url,
          wikipediaExists: Boolean(w.exists),
          language: w.language ?? existing.language,
          // Дата самой проверки: страница Википедии печатает её словами, и
          // подставлять вместо неё дату сборки отчёта было бы неточностью.
          checkedAt: w.lastChecked ?? existing.checkedAt,
          // Запрос проверки — тем же полем, что и у строк выдачи: вопрос
          // «каким запросом это получено» на всём индексе один.
          query: w.query ?? existing.query,
          region: lang.startsWith("ru") ? "RU" : lang ? "UAE" : existing.region,
          // Способ находки: страница печатает «найдена по межъязыковой ссылке»
          // рядом с дословным поисковым запросом, который статью не нашёл.
          foundVia: w.foundVia ?? existing.foundVia,
          langlinkOf:
            w.langlinkOf?.language && w.langlinkOf?.title
              ? { language: String(w.langlinkOf.language), title: String(w.langlinkOf.title) }
              : existing.langlinkOf,
        };
        knownEvidenceRefs.add(ref);
      }
      for (const s of supplement.serpScreenshots ?? []) {
        if (!s.id) continue;
        const ref = `serp_capture:${s.id}`;
        evidenceIndex[ref] = {
          ...(evidenceIndex[ref] ?? {}),
          kind: "serp_screenshot",
          region: s.region,
          engine: s.engine ?? undefined,
          title: "SERP screenshot",
        };
        knownEvidenceRefs.add(ref);
        for (const r of s.evidenceRefs ?? []) knownEvidenceRefs.add(r);
      }
    } catch {
      // non-fatal
    }
  }

  /*
   * Разбор статьи — на записи её проверки, и он может только понижать.
   *
   * Правило то же, что у вердиктов прочитанных страниц (`subjectMatch: "other"`
   * → `OTHER_SUBJECT`), и по той же причине без обратного хода: полный тёзка
   * проходит модельную проверку насквозь, поэтому подтверждённость печати
   * держится детерминированным признаком — ФИО в заголовке или наследование по
   * межъязыковой ссылке, — а не мнением модели.
   */
  const articleReviewPath = join(analyticsDir, WIKIPEDIA_ARTICLE_REVIEW_ARTIFACT);
  if (existsSync(articleReviewPath)) {
    try {
      // Артефакт разбирается своей же схемой, а не полем за полем: писатель и
      // читатель обязаны понимать «годную запись» одинаково.
      const parsed = WikipediaArticleReviewSetSchema.safeParse(readJson<unknown>(articleReviewPath));
      const wikipediaChecks = Object.values(evidenceIndex).filter(
        (e) => e.kind === "wikipedia_check"
      );
      for (const review of parsed.success ? parsed.data.reviews : []) {
        const entry = evidenceIndex[review.checkRef];
        if (!entry) continue;
        entry.articleReview = review;
        if (review.subjectMatch !== "other") continue;
        entry.subjectDecision = "OTHER_SUBJECT";
        /*
         * Понижение идёт по ребру наследования.
         *
         * Наследование по межъязыковой ссылке заводилось затем, чтобы две
         * записи об одной сущности Викиданных не разошлись. Понижение,
         * применённое к одной из них, обязано идти тем же ребром — иначе
         * ru-статья становится «о другом лице», а её en-сестра остаётся
         * подтверждённой, и на соседних страницах отчёта об одной статье
         * сказано разное. Ребро ненаправленное: прочли любую из двух — вывод
         * относится к обеим.
         */
        const language = String(entry.language ?? "").toLowerCase().split(/[-_]/u)[0];
        for (const other of wikipediaChecks) {
          if (other === entry) continue;
          const otherLanguage = String(other.language ?? "").toLowerCase().split(/[-_]/u)[0];
          const linked =
            (language && other.langlinkOf?.language?.toLowerCase() === language) ||
            (otherLanguage && entry.langlinkOf?.language?.toLowerCase() === otherLanguage);
          if (linked) other.subjectDecision = "OTHER_SUBJECT";
        }
      }
    } catch {
      // Нечитаемый разбор — не повод потерять остальной вход: страница просто
      // промолчит о тексте статьи, как молчит на старых артефактах.
    }
  }

  for (const f of mergedBundle.findings) for (const r of f.evidenceRefs) knownEvidenceRefs.add(r);
  for (const u of surfaceUnits) {
    for (const r of u.evidenceRefs) knownEvidenceRefs.add(r);
    for (const c of u.claims) for (const r of c.evidenceRefs) knownEvidenceRefs.add(r);
  }

  let uncategorizedMaterials: UncategorizedMaterialsDeckInput | null = null;
  const uncategorizedPath = join(analyticsDir, "uncategorized-materials.json");
  if (existsSync(uncategorizedPath)) {
    try {
      const raw = readJson<{
        count?: number;
        byRegion?: UncategorizedMaterialsDeckInput["byRegion"];
        topExamples?: Array<{
          title?: string;
          evidenceRef?: string;
          domain?: string;
          region?: string;
        }>;
      }>(uncategorizedPath);
      const byRegion: UncategorizedMaterialsDeckInput["byRegion"] = {};
      for (const [region, bucket] of Object.entries(raw.byRegion ?? {})) {
        byRegion[region] = {
          count: Number(bucket?.count ?? 0) || 0,
          examples: (bucket?.examples ?? [])
            .filter((e) => e?.evidenceRef)
            .map((e) => ({
              title: String(e.title ?? "").trim() || "(без заголовка)",
              evidenceRef: String(e.evidenceRef),
              domain: e.domain ? String(e.domain) : undefined,
            })),
        };
      }
      uncategorizedMaterials = {
        count: Number(raw.count ?? 0) || 0,
        byRegion,
      };
      /*
       * Вторичная ингестия дополняет индекс, а не переписывает его.
       *
       * Запись примера несёт только заголовок, домен и регион. Записанная
       * поверх наблюдения, она стирала позицию, запрос и движок: на прогоне 76
       * в примеры «прочих материалов» ОАЭ попали серперные строки 3
       * (opensanctions.org), 4 (bloomberg.com) и 10 (wikidata.org) — после
       * перезаписи у них не осталось запроса таблицы, они выпали из ТОП-20, а
       * освободившиеся места заняла нумерация обогатителя. Соседний цикл
       * `topExamples` эту охрану имел с самого начала.
       */
      for (const [region, bucket] of Object.entries(byRegion)) {
        for (const ex of bucket.examples) {
          knownEvidenceRefs.add(ex.evidenceRef);
          const known = evidenceIndex[ex.evidenceRef];
          evidenceIndex[ex.evidenceRef] = known
            ? { ...known, uncategorizedExample: true }
            : {
                title: ex.title,
                domain: ex.domain,
                kind: "uncategorized",
                region: mapRegionBucket(region),
                uncategorizedExample: true,
              };
        }
      }
      for (const ex of raw.topExamples ?? []) {
        if (!ex?.evidenceRef) continue;
        knownEvidenceRefs.add(ex.evidenceRef);
        if (!evidenceIndex[ex.evidenceRef]) {
          evidenceIndex[ex.evidenceRef] = {
            title: String(ex.title ?? "").trim() || undefined,
            domain: ex.domain ? String(ex.domain) : undefined,
            kind: "uncategorized",
            region: ex.region ? mapRegionBucket(ex.region) : undefined,
            uncategorizedExample: true,
          };
        }
      }
    } catch {
      uncategorizedMaterials = null;
    }
  }

  /*
   * Решение о персоне субъекта — снимком прогона, а не запросом в базу.
   *
   * Отсутствие файла ошибкой не является: артефакт появился позже самой колоды,
   * и старые прогоны его не знают. Пустое поле `record` значит ровно «решения у
   * кейса нет», и лист «Кого проверяли» печатает именно это.
   */
  let personaDecision: PersonaDecisionRecord | null = null;
  const personaPath = join(analyticsDir, PERSONA_DECISION_ARTIFACT);
  if (existsSync(personaPath)) {
    try {
      const artifact = readJson<{ record?: PersonaDecisionRecord | null }>(personaPath);
      const record = artifact.record ?? null;
      // Признак — данные: решением считается только записанное слово решения.
      personaDecision =
        record?.decision === "PERSONA_SELECTED" || record?.decision === "APPROVED_WITHOUT_PERSONA"
          ? record
          : null;
    } catch {
      // Нечитаемый артефакт — не повод потерять остальной вход деки.
      personaDecision = null;
    }
  }

  const metricSnapshot: MetricSnapshot = {
    metricSnapshotId: `${binding.datasetId}-metrics`,
    datasetId: binding.datasetId,
    reportRunId: binding.baseReportRunId,
    baseCount: observations.baseCount,
    enrichmentCount: providerDelta.arsenkinObservationCount,
    compositeCount: observations.compositeCount,
    analyzedCount:
      typeof analysisScope?.analyzed === "number" ? analysisScope.analyzed : undefined,
    analysisTopN: typeof analysisScope?.topN === "number" ? analysisScope.topN : undefined,
    analysisLanes: analysisLanes.length > 0 ? analysisLanes : undefined,
    linkThemes: linkThemes.length > 0 ? linkThemes : undefined,
    linkThemesByRegion,
    // Поля нет вовсе, когда чтения в прогоне не было: отсутствие метрики и
    // измеренный ноль — разные утверждения перед клиентом.
    linkReadByRegion: linkVerdicts
      ? countLinkReadByRegion(linkVerdicts.verdicts ?? [])
      : undefined,
    linkUnreadCount: linkVerdicts?.summary?.unread,
    linkReading: linkVerdicts?.reading
      ? {
          status: (linkVerdicts.reading.status ?? "NO_LINKS") as LinkReadingReport["status"],
          requested: Number(linkVerdicts.reading.requested ?? 0),
          read: Number(linkVerdicts.reading.read ?? 0),
          failed: Number(linkVerdicts.reading.failed ?? 0),
          retried: Number(linkVerdicts.reading.retried ?? 0),
          byReason: linkVerdicts.reading.byReason ?? {},
        }
      : undefined,
    // Same unit as compositeCount (observation rows), not inventory decisions.
    subjectMatchCount: identityCounts.subjectMatchCount,
    likelySubjectCount: identityCounts.likelySubjectCount,
    // «Требуют идентификации» покрывает и смешанные признаки, и полное их
    // отсутствие: для читателя это один вопрос — материал не отнесён к лицу.
    ambiguousCount: identityCounts.ambiguousCount + identityCounts.insufficientCount,
    otherSubjectCount: identityCounts.otherSubjectCount,
    adverseFindingCount: bundle.findings.filter(
      (f) => f.subjectMatch === "SUBJECT_MATCH" && (RISK_ORDER[f.riskLevel] ?? 0) >= 2
    ).length,
    perRegionCounts,
    perRegionLikelyCounts,
  };

  return {
    caseId: binding.caseId,
    reportRunId: binding.baseReportRunId,
    sourceDatasetId: binding.datasetId,
    mergedBundle,
    surfaceUnits,
    evidenceIndex,
    knownEvidenceRefs,
    metricSnapshot,
    executiveSummary,
    composedClientSummary,
    subjectResolution,
    baseCountBefore: providerDelta.baseCount,
    baseCountAfter: observations.baseCount,
    uncategorizedMaterials,
    surfaceCollectionHints,
    complianceScreenings,
    personaDecision,
    serpObservations: observations.observations,
  };
}
