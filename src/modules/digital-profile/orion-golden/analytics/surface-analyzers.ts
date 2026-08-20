/**
 * Prompt 2 — independent typed surface analyzers.
 * Each analyzer returns SurfaceAnalysis units (typed metrics + claims),
 * never slide copy. Analyzers: organic, suggestions, PAA/related, images,
 * Wikipedia/identity, knowledge/AI answers, URL audit/indexation,
 * existing compliance evidence.
 */

import type { RawInventoryItem } from "../types";
import {
  mapEngineBucket,
  mapRegionBucket,
  mapSurfaceBucket,
} from "../classic/composite-serp-overlay-merge";
import {
  SURFACE_ANALYSIS_SCHEMA_VERSION,
  SurfaceAnalysisSchema,
  type SurfaceAnalysis,
  type SurfaceAnalysisUnit,
} from "../contracts/surface-analysis";
import type { SubjectRelevanceDecision, SurfaceKind } from "../contracts/common";
import type { SubjectResolutionItem } from "../contracts/subject-resolution";
import { getAdversePatterns } from "../../config/finding-themes";

export type ResolutionLookup = Map<string, SubjectResolutionItem>; // by evidenceRef

/** REMEDIATION §3.1 — live view of configured adversePatterns. */
export const ADVERSE_PATTERNS: Pick<RegExp, "test"> = {
  test: (text: string) => getAdversePatterns().test(text),
};

/**
 * Слова, которыми строка-маркер говорит «поверхность спрошена, данных нет».
 *
 * «Ответ не предоставлен» — отказ генеративной модели: вопрос задан, ответ
 * получен и он отрицательный. Это измеренная пустота, а не находка и не сбой,
 * поэтому маркер обязан считаться здесь; словами он от «не найдено»
 * отличается, чтобы страница не выдавала отказ за отсутствие ответа.
 */
export const NOT_FOUND_PATTERNS =
  /не найден|ответ не предоставлен|not found|отсутствует или пуст|нет блока|no results|н\/д/iu;

function refOf(item: RawInventoryItem): string {
  return `inventory:${item.inventoryId}`;
}

function decisionFor(item: RawInventoryItem, lookup: ResolutionLookup): SubjectRelevanceDecision {
  return lookup.get(refOf(item))?.decision ?? "INSUFFICIENT_IDENTIFIERS";
}

function isAdverse(item: RawInventoryItem): boolean {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  // Analyst overrides (§1.3): manual neutral wins; manual adverse forces adverse.
  if (meta.analystNeutral === true) return false;
  if (meta.analystAdverse === true) return true;
  const text = [item.title, item.snippet, item.classification].filter(Boolean).join(" ");
  if (/criminal_allegation|adverse_media|sanctions|pep_rca|PEP|SANCTIONS/iu.test(String(item.classification ?? ""))) {
    return true;
  }
  return ADVERSE_PATTERNS.test(text);
}

/**
 * Длина, до которой сниппет ещё читается как служебная пометка, а не как текст
 * материала. Пометки поверхностей укладываются в пару фраз («Фактическая
 * проверка Wikipedia: статья не найдена.» — 46 знаков), нейро-ответ поисковика
 * идёт на тысячи.
 */
const MAX_MARKER_SNIPPET_CHARS = 240;

/** Виды строк, которые сборщик сам объявил пометкой о пустоте. */
const EMPTY_MARKER_KINDS = new Set(["absent", "answer_rejected"]);
/** Виды строк, которые сборщик сам объявил материалом. */
const MATERIAL_KINDS = new Set(["answer_text", "answer_source"]);

/**
 * Строка-маркер «поверхность спрошена, данных нет».
 *
 * Где вид строки известен, решает он: сборщик единственный знает наверняка,
 * ответ это или пометка, и гадать по словам поверх его ответа значило бы
 * завести второй ответ на тот же вопрос. Короткий настоящий ответ-отрицание
 * («Сведений о судимости не найдено; он указан как основатель …») иначе
 * расходился с декой: анализатор считал его пустотой, страница печатала его
 * с подписью, и над напечатанным ответом стояло «Показано 0 результатов».
 *
 * Для чужих поверхностей вид не пишется, и остаётся разбор по словам: признак
 * ищется в заголовке — либо в сниппете, но только пока весь сниппет и есть
 * служебная пометка. Сверять сниппет любой длины нельзя (в него едет текст
 * ответа), только заголовок — тоже: у записи проверки Википедии он нейтральный
 * («Wikipedia»), и признак живёт ровно в сниппете.
 */
function isEmptyMarker(item: RawInventoryItem): boolean {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  const contentKind = String(meta.contentKind ?? "").trim();
  if (EMPTY_MARKER_KINDS.has(contentKind)) return true;
  if (MATERIAL_KINDS.has(contentKind)) return false;

  if (NOT_FOUND_PATTERNS.test(String(item.title ?? ""))) return true;
  const snippet = String(item.snippet ?? "").trim();
  return snippet.length > 0 && snippet.length <= MAX_MARKER_SNIPPET_CHARS
    ? NOT_FOUND_PATTERNS.test(snippet)
    : false;
}

type UnitAccumulator = {
  surface: SurfaceKind;
  region: string;
  engine?: string;
  items: RawInventoryItem[];
};

function groupBy(
  items: RawInventoryItem[],
  surface: SurfaceKind,
  withEngine: boolean
): UnitAccumulator[] {
  const map = new Map<string, UnitAccumulator>();
  for (const item of items) {
    const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
    const region = mapRegionBucket(item.region);
    const engine = withEngine ? mapEngineBucket(String(meta.engine ?? item.provider ?? "")) : undefined;
    const key = `${region}|${engine ?? "-"}`;
    const acc = map.get(key) ?? { surface, region, engine, items: [] };
    acc.items.push(item);
    map.set(key, acc);
  }
  return [...map.values()];
}

function buildUnit(acc: UnitAccumulator, lookup: ResolutionLookup): SurfaceAnalysisUnit {
  const collected = acc.items.filter((i) => !isEmptyMarker(i));
  const emptyMarkers = acc.items.length - collected.length;
  const subjectMatched = collected.filter((i) => decisionFor(i, lookup) === "SUBJECT_MATCH");
  const likelySubject = collected.filter((i) => decisionFor(i, lookup) === "LIKELY_SUBJECT");
  const otherSubject = collected.filter((i) => decisionFor(i, lookup) === "OTHER_SUBJECT");
  const ambiguous = collected.filter((i) => decisionFor(i, lookup) === "AMBIGUOUS");
  const adverseSubject = subjectMatched.filter(isAdverse);

  // Empty markers (NO_RESULTS / «не найден») mean the surface was probed —
  // that is MEASURED-empty, not NOT_COLLECTED (§7.4).
  const sampleStatus =
    collected.length > 0 || emptyMarkers > 0 ? ("MEASURED" as const) : ("NOT_COLLECTED" as const);

  const claims = [...adverseSubject, ...otherSubject.slice(0, 3)].map((item, idx) => ({
    claimId: `${acc.surface}-${acc.region}-${acc.engine ?? "any"}-${idx}-${item.inventoryId}`,
    text: String(item.title ?? "").slice(0, 300) || "(untitled)",
    subjectMatch: decisionFor(item, lookup),
    evidenceRefs: [refOf(item)],
    riskHint: isAdverse(item) ? "adverse" : "identity_pollution",
  }));

  return {
    surface: acc.surface,
    region: acc.region,
    engine: acc.engine,
    metrics: [
      { key: "totalCount", value: collected.length, sampleStatus, denominator: collected.length },
      { key: "subjectMatchCount", value: subjectMatched.length, sampleStatus },
      { key: "likelySubjectCount", value: likelySubject.length, sampleStatus },
      { key: "otherSubjectCount", value: otherSubject.length, sampleStatus },
      { key: "ambiguousCount", value: ambiguous.length, sampleStatus },
      {
        key: "adverseSubjectCount",
        value: adverseSubject.length,
        sampleStatus,
        denominator: subjectMatched.length,
      },
      { key: "emptyMarkerCount", value: emptyMarkers, sampleStatus: "MEASURED" },
    ],
    claims,
    evidenceRefs: acc.items.map(refOf),
    // Не только сколько маркеров, но и какие именно: потребителю (странице
    // поверхности) нужно не печатать их плитками, а по заголовку он их не
    // отличит — «не найдено» стоит в сниппете, которого у него нет.
    emptyMarkerRefs: acc.items.filter(isEmptyMarker).map(refOf),
  };
}

type AnalyzerDef = {
  surface: SurfaceKind;
  withEngine: boolean;
  select: (item: RawInventoryItem) => boolean;
};

function surfaceOf(item: RawInventoryItem): string {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  return mapSurfaceBucket(String(meta.surface ?? item.evidenceType ?? ""));
}

export const SURFACE_ANALYZERS: AnalyzerDef[] = [
  {
    surface: "organic",
    withEngine: true,
    select: (i) => i.evidenceType === "search_result" || surfaceOf(i) === "organic",
  },
  {
    surface: "suggestions",
    withEngine: true,
    select: (i) => i.evidenceType === "suggestion" || surfaceOf(i) === "autocomplete",
  },
  {
    surface: "paa_related",
    withEngine: true,
    select: (i) => i.evidenceType === "related_query" || surfaceOf(i) === "paa",
  },
  {
    surface: "images",
    withEngine: false,
    select: (i) => i.evidenceType === "image_result" || surfaceOf(i) === "images",
  },
  {
    surface: "wikipedia",
    withEngine: false,
    // Encyclopedia articles usually arrive as ORGANIC rows — detect them by
    // domain too, otherwise the identity page falsely reports "no Wikipedia
    // article" while wikipedia.org rows sit in the SERP table of the report.
    select: (i) =>
      i.evidenceType === "wikipedia" ||
      i.evidenceType === "wikipedia_check" ||
      surfaceOf(i) === "wikipedia" ||
      /(?:^|[./])(?:wikipedia\.org|ruwiki\.ru|cyclowiki\.org)\//iu.test(String(i.sourceUrl ?? "")),
  },
  {
    surface: "ai_answers",
    withEngine: true,
    select: (i) =>
      i.evidenceType === "ai_answer" ||
      i.evidenceType === "knowledge_block" ||
      surfaceOf(i) === "ai_answer",
  },
  {
    surface: "url_audit",
    withEngine: true,
    select: (i) =>
      i.evidenceType === "indexation" ||
      i.evidenceType === "page_meta" ||
      surfaceOf(i) === "indexation" ||
      surfaceOf(i) === "page_meta",
  },
  {
    surface: "compliance",
    withEngine: false,
    select: (i) =>
      i.evidenceType === "compliance_hit" ||
      i.evidenceType === "risk_finding" ||
      i.source === "database_profile" ||
      i.source === "risk_finding",
  },
];

export function runSurfaceAnalyzers(input: {
  caseId: string;
  datasetId: string;
  items: RawInventoryItem[];
  resolutionLookup: ResolutionLookup;
  sourceHashes: string[];
}): Record<SurfaceKind, SurfaceAnalysis> {
  const out = {} as Record<SurfaceKind, SurfaceAnalysis>;
  for (const def of SURFACE_ANALYZERS) {
    const selected = input.items.filter(def.select);
    const units = groupBy(selected, def.surface, def.withEngine).map((acc) =>
      buildUnit(acc, input.resolutionLookup)
    );
    out[def.surface] = SurfaceAnalysisSchema.parse({
      schemaVersion: SURFACE_ANALYSIS_SCHEMA_VERSION,
      caseId: input.caseId,
      datasetId: input.datasetId,
      sourceHashes: input.sourceHashes,
      evidenceRefs: selected.map(refOf),
      units,
    });
  }
  return out;
}
