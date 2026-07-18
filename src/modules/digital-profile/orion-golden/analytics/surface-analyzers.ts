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

export type ResolutionLookup = Map<string, SubjectResolutionItem>; // by evidenceRef

export const ADVERSE_PATTERNS =
  /санкц|sanction|watch.?list|уголов|criminal|арест|arrest|суд|court|прокур|мошенн|fraud|коррупц|corrupt|отмыв|launder|обыск|розыск|компромат|скандал|расследован|investigat|adverse|безопасн.*служб|спецслужб|security service|national security|фсб|fsb/iu;

export const NOT_FOUND_PATTERNS =
  /не найден|not found|отсутствует или пуст|нет блока|no results|н\/д/iu;

function refOf(item: RawInventoryItem): string {
  return `inventory:${item.inventoryId}`;
}

function decisionFor(item: RawInventoryItem, lookup: ResolutionLookup): SubjectRelevanceDecision {
  return lookup.get(refOf(item))?.decision ?? "INSUFFICIENT_IDENTIFIERS";
}

function isAdverse(item: RawInventoryItem): boolean {
  const text = [item.title, item.snippet, item.classification].filter(Boolean).join(" ");
  if (/criminal_allegation|adverse_media|sanctions|pep_rca|PEP|SANCTIONS/iu.test(String(item.classification ?? ""))) {
    return true;
  }
  return ADVERSE_PATTERNS.test(text);
}

function isEmptyMarker(item: RawInventoryItem): boolean {
  return NOT_FOUND_PATTERNS.test(`${item.title} ${item.snippet ?? ""}`);
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
  const otherSubject = collected.filter((i) => decisionFor(i, lookup) === "OTHER_SUBJECT");
  const ambiguous = collected.filter((i) => decisionFor(i, lookup) === "AMBIGUOUS");
  const adverseSubject = subjectMatched.filter(isAdverse);

  const sampleStatus =
    collected.length > 0 ? "MEASURED" : emptyMarkers > 0 ? "NOT_COLLECTED" : "NOT_COLLECTED";

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
