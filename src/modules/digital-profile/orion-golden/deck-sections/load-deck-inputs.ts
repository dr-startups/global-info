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
} from "./scoped-input";
import { normalizeCoverageSurface } from "./scoped-input";
import { normalizeSourceType } from "../analytics/source-type";
import { pageQuoteForClient } from "../analytics/client-quote-hygiene";
import { linkReadingClientLine } from "../analytics/link-reading-agent";
import { mapRegionBucket } from "../classic/composite-serp-overlay-merge";

type CompositeObservationRow = {
  observationKey?: string;
  surface: string;
  region: string;
  engine?: string;
  url?: string;
  title?: string;
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
  verdicts: Array<{
    evidenceRef?: string;
    region?: string;
    subjectMatch?: string;
    tone?: string;
    readFailure?: string;
  }>
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
  const probedRegions = new Set<string>();
  const answeredRegions = new Set<string>();
  for (const o of observations) {
    const region = mapRegionBucket(o.region);
    if (!region) continue;
    const surface = normalizeCoverageSurface(o.surface);
    if (surface === "organic" && isGoogle(o.engine)) probedRegions.add(region);
    if (surface === "ai_answers") answeredRegions.add(region);
  }
  const alreadyKnown = new Set(
    existing
      .filter((h) => normalizeCoverageSurface(h.surface) === "ai_answers")
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
        verdicts?: Array<{
          evidenceRef?: string;
          region?: string;
          subjectMatch?: string;
          tone?: string;
          theme?: string;
          sourceType?: string;
          quotes?: Array<{ text?: string }>;
          /** Заполнено — страницу прочитать не удалось; решения по ней нет. */
          readFailure?: string;
        }>;
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

  /*
   * Решение по прочитанной странице сильнее заголовка.
   *
   * Оценка в таблице выдачи ставилась по словам в заголовке: «суд», «санкции»,
   * «арест». Так телеинтервью 2015 года получило метку «Нежелательный», а
   * страница санкционного списка без этих слов — «Нейтральный». Решение
   * вынесено по тексту страницы и с цитатой, поэтому оно и назначает оценку.
   *
   * Материал, признанный чужим («это однофамилец»), перестаёт быть
   * подтверждением чего-либо о субъекте — независимо от того, что решил
   * классификатор по заголовку.
   */
  for (const v of linkVerdicts?.verdicts ?? []) {
    const ref = String(v.evidenceRef ?? "");
    if (!ref || !evidenceIndex[ref]) continue;
    /*
     * Непрочитанная страница решения не приносит.
     *
     * Страницу не открыли — модель честно отвечает «не знаем»: `unclear`,
     * `neutral`, темой становится заголовок выдачи. Применённый наравне с
     * настоящим, такой вердикт гасил словарную метку «Нежелательный» и писал
     * `readVerdictTone`, по которому потребители отличают прочитанную страницу
     * от непрочитанной. Про заблокированную страницу словарь — всё, что есть.
     */
    if (v.readFailure) continue;
    const quoted = (v.quotes ?? []).some((q) => String(q?.text ?? "").trim().length > 0);
    if (v.tone === "adverse" && quoted) evidenceIndex[ref].adverse = true;
    if (v.tone === "supportive" || v.tone === "neutral") evidenceIndex[ref].adverse = false;
    if (v.subjectMatch === "other") {
      evidenceIndex[ref].adverse = false;
      evidenceIndex[ref].subjectDecision = "OTHER_SUBJECT";
    }
    // Тип источника определён по самой странице — он сильнее догадки по домену.
    const sourceType = normalizeSourceType(v.sourceType);
    if (sourceType) evidenceIndex[ref].sourceType = sourceType;
    // Тон прочитанной страницы запоминается отдельно: по нему темы повышенного
    // внимания отбирают, что можно цитировать. Словарь ключевых слов работает
    // по заголовку и о содержимом страницы не знает.
    if (v.tone === "adverse" || v.tone === "neutral" || v.tone === "supportive") {
      evidenceIndex[ref].readVerdictTone = v.tone;
    }
    // «О чём публикация» одной русской фразой — из решения по прочитанной
    // странице. Иноязычная цитата печатается дословно, а эта строка идёт рядом.
    const theme = String(v.theme ?? "").trim();
    if (theme) evidenceIndex[ref].verdictTheme = theme;
    // Первая годная цитата со страницы: она и станет цитатой в отчёте вместо
    // обрезанного заголовка выдачи.
    for (const q of v.quotes ?? []) {
      const quote = pageQuoteForClient(q?.text);
      if (quote) {
        evidenceIndex[ref].pageQuote = quote;
        break;
      }
    }
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
        const ref = `inventory:wiki-${w.id}`;
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
      for (const [region, bucket] of Object.entries(byRegion)) {
        for (const ex of bucket.examples) {
          knownEvidenceRefs.add(ex.evidenceRef);
          evidenceIndex[ex.evidenceRef] = {
            title: ex.title,
            domain: ex.domain,
            kind: "uncategorized",
            region: mapRegionBucket(region),
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
          };
        }
      }
    } catch {
      uncategorizedMaterials = null;
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
    linkReadingLine: linkVerdicts?.reading
      ? linkReadingClientLine({
          status: (linkVerdicts.reading.status ?? "NO_LINKS") as never,
          requested: Number(linkVerdicts.reading.requested ?? 0),
          read: Number(linkVerdicts.reading.read ?? 0),
          failed: Number(linkVerdicts.reading.failed ?? 0),
          retried: Number(linkVerdicts.reading.retried ?? 0),
          byReason: linkVerdicts.reading.byReason ?? {},
        })
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
  };
}
