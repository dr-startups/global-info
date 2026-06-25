/**
 * Search-surface report mapper (Stage H3).
 *
 * Produces compact, evidence-backed summaries of the extra search surfaces for
 * future inclusion in report_json. The existing report builder is intentionally
 * NOT modified at this stage — this mapper is standalone and only consumed once
 * the full template lands.
 *
 * TODO (Stage K): wire `buildSurfacesReportSection` into report-builder-service
 * and the PPTX template once the report layout for surfaces is finalized.
 */

import type { SearchSurfaceItem, SearchSurfaceType } from "../search-surfaces/types";

export interface SurfaceSummary {
  total: number;
  reviewed: number;
  mock: number;
  real: number;
  manual: number;
  /** A few representative captions/queries for the report. */
  samples: string[];
}

export interface SurfacesReportSection {
  suggestionsSummary: SurfaceSummary;
  relatedQueriesSummary: SurfaceSummary;
  imagesSummary: SurfaceSummary;
  videosSummary: SurfaceSummary;
  knowledgeBlockSummary: SurfaceSummary;
  screenshotEvidenceSummary: SurfaceSummary;
}

function summarize(items: SearchSurfaceItem[]): SurfaceSummary {
  const samples = items
    .slice(0, 5)
    .map((i) => i.query ?? i.title ?? i.url ?? "")
    .filter(Boolean);
  return {
    total: items.length,
    reviewed: items.filter((i) => i.reviewStatus === "REVIEWED").length,
    mock: items.filter((i) => i.source === "MOCK").length,
    real: items.filter((i) => i.source.startsWith("REAL_")).length,
    manual: items.filter((i) => i.source === "MANUAL_IMPORT").length,
    samples,
  };
}

function byType(items: SearchSurfaceItem[], type: SearchSurfaceType): SearchSurfaceItem[] {
  return items.filter((i) => i.type === type);
}

export function buildSurfacesReportSection(
  items: SearchSurfaceItem[]
): SurfacesReportSection {
  return {
    suggestionsSummary: summarize(byType(items, "SUGGESTION")),
    relatedQueriesSummary: summarize(byType(items, "RELATED_QUERY")),
    imagesSummary: summarize(byType(items, "IMAGE_RESULT")),
    videosSummary: summarize(byType(items, "VIDEO_RESULT")),
    knowledgeBlockSummary: summarize(byType(items, "KNOWLEDGE_BLOCK")),
    screenshotEvidenceSummary: summarize(byType(items, "SERP_SCREENSHOT")),
  };
}
