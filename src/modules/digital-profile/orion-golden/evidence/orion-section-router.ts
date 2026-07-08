/**
 * R10 — Section-aware evidence routing (no global slice).
 */

import type { FullEvidenceInventory } from "./full-evidence-inventory";
import type { EvidenceDecisionRecord } from "../types";
import type { RelevanceFilterInspection } from "./relevance-classifier";
import type { OrionGoldenSectionKey, SectionEvidencePack } from "../types";

export interface EvidenceRoutingInspection {
  version: "r10-evidence-routing-inspection-v1";
  caseId: string;
  reportRunId: string;
  totalInventoryItems: number;
  totalSearchResults: number;
  searchResultsAccounted: number;
  searchResultsUnaccounted: number;
  sections: Array<{
    sectionKey: string;
    rawEntered: number;
    selected: number;
    excluded: number;
    displayBudget: number;
    dataPoor: boolean;
    topExclusionReasons: string[];
  }>;
  dataPoorSections: string[];
  warnings: string[];
  packs: SectionEvidencePack[];
}

/** Per-section display budgets (slide tables) — analysis sees full routed set. */
const SECTION_DISPLAY_BUDGET: Partial<Record<OrionGoldenSectionKey, number>> = {
  ru_search_results: 20,
  uae_search_results: 20,
  ru_audit_summary: 30,
  uae_audit_summary: 30,
  ru_suggestions: 15,
  uae_suggestions: 15,
  ru_images: 12,
  uae_images: 12,
  ru_videos: 8,
  uae_videos: 8,
  ru_knowledge: 6,
  uae_knowledge: 6,
  compliance_databases: 25,
  lexisnexis: 40,
  appendix: 50,
};

const ROUTING_SECTIONS: OrionGoldenSectionKey[] = [
  "global_summary_inputs",
  "ru_audit_summary",
  "ru_search_results",
  "ru_serp_screenshots",
  "ru_suggestions",
  "ru_images",
  "ru_videos",
  "ru_knowledge",
  "ru_wikipedia",
  "uae_audit_summary",
  "uae_search_results",
  "uae_serp_screenshots",
  "uae_suggestions",
  "uae_images",
  "uae_videos",
  "uae_knowledge",
  "uae_wikipedia",
  "compliance_databases",
  "lexisnexis",
  "dow_jones",
  "world_check",
  "offer_context",
  "appendix",
] as OrionGoldenSectionKey[];

function matchesSection(
  sectionKey: OrionGoldenSectionKey,
  decision: EvidenceDecisionRecord,
  itemType: string,
  provider: string,
  region: string
): boolean {
  const sk = sectionKey;
  const p = provider.toUpperCase();
  const r = region.toUpperCase();
  const t = itemType.toLowerCase();

  if (sk === "global_summary_inputs") {
    return decision.includeInClientReport;
  }
  if (sk === "appendix") {
    return decision.includeInAppendix || decision.relevanceClass === "excluded_noise";
  }
  if (sk === "ru_audit_summary" || sk === "uae_audit_summary") {
    const ru = sk.startsWith("ru");
    const regionOk = ru ? r !== "UAE" && r !== "INTL" : r === "UAE" || r === "INTL";
    return regionOk && (t === "search_result" || t === "risk_finding" || t === "compliance_hit");
  }
  if (sk === "ru_search_results" || sk === "uae_search_results") {
    const ru = sk.startsWith("ru");
    const regionOk = ru ? r !== "UAE" && r !== "INTL" : r === "UAE" || r === "INTL";
    return regionOk && t === "search_result";
  }
  if (sk.includes("serp") || sk.includes("screenshot")) {
    return t.includes("serp") || t === "serp_screenshot";
  }
  if (sk.includes("suggestion")) {
    return t === "suggestion";
  }
  if (sk.includes("image")) {
    return t.includes("image");
  }
  if (sk.includes("video")) {
    return t.includes("video");
  }
  if (sk.includes("knowledge")) {
    return t.includes("knowledge");
  }
  if (sk.includes("wikipedia")) {
    return t === "wikipedia";
  }
  if (sk === "compliance_databases") {
    return t === "compliance_hit";
  }
  if (sk === "lexisnexis") {
    return p.includes("LEXIS");
  }
  if (sk === "dow_jones") {
    return p.includes("DOW");
  }
  if (sk === "world_check") {
    return p.includes("WORLD") || p.includes("WORLDCHECK");
  }
  if (sk === "offer_context") {
    return t === "offer_static";
  }
  return false;
}

export function routeEvidenceToSections(input: {
  inventory: FullEvidenceInventory;
  relevance: RelevanceFilterInspection;
}): EvidenceRoutingInspection {
  const decisionById = new Map(input.relevance.decisions.map((d) => [d.inventoryId, d]));
  const packs: SectionEvidencePack[] = [];
  const searchResultIds = new Set(
    input.inventory.items.filter((i) => i.evidenceType === "search_result").map((i) => i.inventoryId)
  );
  const accountedSearch = new Set<string>();

  for (const sectionKey of ROUTING_SECTIONS) {
    const routed: EvidenceDecisionRecord[] = [];
    for (const item of input.inventory.items) {
      const decision = decisionById.get(item.inventoryId);
      if (!decision) continue;
      if (
        matchesSection(sectionKey, decision, item.evidenceType, item.provider, item.region)
      ) {
        routed.push(decision);
        if (searchResultIds.has(item.inventoryId)) accountedSearch.add(item.inventoryId);
      }
    }

    const selected = routed.filter((d) => d.includeInClientReport);
    const excluded = routed.filter((d) => !d.includeInClientReport || d.relevanceClass === "excluded_noise");
    const displayBudget = SECTION_DISPLAY_BUDGET[sectionKey] ?? 20;
    const selectedForDisplay = selected.slice(0, displayBudget);
    const exclusionReasons = [...new Set(excluded.map((e) => e.exclusionReason ?? e.relevanceClass))].slice(0, 5);

    packs.push({
      sectionKey,
      totalInSection: routed.length,
      selectedCount: selected.length,
      excludedCount: excluded.length,
      displayBudget,
      selectedForDisplay,
      selectedForAnalysis: selected,
      excluded,
      metrics: {
        totalInSection: routed.length,
        selectedCount: selected.length,
        excludedCount: excluded.length,
        displayShown: selectedForDisplay.length,
        fullCountForAnalysis: selected.length,
      },
      warnings: routed.length === 0 ? [`section-${sectionKey}-data-poor`] : [],
    });
  }

  const sectionSummaries = packs.map((p) => ({
    sectionKey: p.sectionKey,
    rawEntered: p.totalInSection,
    selected: p.selectedCount,
    excluded: p.excludedCount,
    displayBudget: p.displayBudget,
    dataPoor: p.totalInSection === 0,
    topExclusionReasons: [...new Set(p.excluded.map((e) => e.exclusionReason ?? e.relevanceClass))].slice(0, 3),
  }));

  const dataPoorSections = sectionSummaries.filter((s) => s.dataPoor).map((s) => s.sectionKey);
  const searchResultsUnaccounted = searchResultIds.size - accountedSearch.size;

  return {
    version: "r10-evidence-routing-inspection-v1",
    caseId: input.inventory.caseId,
    reportRunId: input.inventory.reportRunId,
    totalInventoryItems: input.inventory.items.length,
    totalSearchResults: input.inventory.counts.searchResults,
    searchResultsAccounted: accountedSearch.size,
    searchResultsUnaccounted,
    sections: sectionSummaries,
    dataPoorSections,
    warnings: [
      ...(searchResultsUnaccounted > 0
        ? [`${searchResultsUnaccounted} search results not routed to any section (may be weak_match only in appendix)`]
        : []),
      ...dataPoorSections.map((s) => `data-poor:${s}`),
    ],
    packs,
  };
}

export function validateRoutingAgainstBlueprint(routing: EvidenceRoutingInspection): string[] {
  const issues: string[] = [];
  const packKeys = new Set(routing.packs.map((p) => p.sectionKey));
  for (const sectionKey of ROUTING_SECTIONS) {
    if (!packKeys.has(sectionKey)) issues.push(`missing-pack:${sectionKey}`);
  }
  if (routing.searchResultsUnaccounted > routing.totalSearchResults * 0.5) {
    issues.push("majority-search-results-unaccounted");
  }
  return issues;
}
