/**
 * Composite surface-aware overlay merge for base ORION + Arsenkin enrichment.
 *
 * Enrichment replaces base evidence only for coverage cells it actually collected
 * (region + engine + surface). Uncovered cells keep base provenance.
 */

import { createHash } from "node:crypto";
import { listSerpObservationsForAuditRun } from "../../serp-observation";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { RawInventoryItem } from "../types";
import { observationKey } from "./client-language";
import type { ArsenkinReportBindingV2, CoveredSurfaceCell } from "./arsenkin-report-binding";
import { toCompositeBindingModel } from "./arsenkin-report-binding";

export type SampleStatus = "MEASURED" | "NOT_COLLECTED" | "NOT_APPLICABLE";

export type SurfaceCellKey = {
  region: string;
  engine: string;
  surface: string;
};

export type CompositeSurfaceOwnership = SurfaceCellKey & {
  owner: "base" | "enrichment" | "legacy";
  reportRunId: string;
  provider?: string;
  observationCount: number;
  sampleStatus: SampleStatus;
};

export type CompositeMergeProvenance = {
  version: "composite-serp-merge-v1";
  baseReportRunId: string | null;
  enrichmentRunIds: string[];
  ownership: CompositeSurfaceOwnership[];
  countsBefore: {
    searchResults: number;
    suggestions: number;
    related: number;
  };
  countsAfter: {
    searchResults: number;
    suggestions: number;
    related: number;
  };
  replacedCells: number;
  preservedCells: number;
  warnings: string[];
};

export type CompositeMergeResult = {
  inventory: FullEvidenceInventory;
  observationCount: number;
  duplicateKeys: string[];
  usedRunScoped: boolean;
  warnings: string[];
  provenance: CompositeMergeProvenance;
};

function normalizeUrl(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "");
}

function valueHash(url: string, title: string | null | undefined): string {
  return createHash("sha1")
    .update(`${normalizeUrl(url)}|${String(title ?? "").trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

export function mapRegionBucket(raw: string): string {
  const r = String(raw ?? "").toUpperCase();
  if (/UAE|AE|INTL|EN|GLOBAL_INTL/.test(r)) return "UAE";
  if (/RU|RUSSIA|RF/.test(r)) return "RU";
  return r || "RU";
}

export function mapEngineBucket(raw: string): string {
  const e = String(raw ?? "").toUpperCase();
  if (/YANDEX|YA\b/.test(e)) return "YANDEX";
  if (/GOOGLE|SERPER|GSEARCH/.test(e)) return "GOOGLE";
  return e || "UNKNOWN";
}

export function mapSurfaceBucket(raw: string): string {
  const s = String(raw ?? "").toLowerCase();
  if (s.includes("suggest") || s.includes("autocomplete")) return "autocomplete";
  if (s.includes("paa") || s.includes("related")) return "paa";
  if (s.includes("organic") || s === "search_result" || s.includes("search")) return "organic";
  if (s.includes("image")) return "images";
  if (s.includes("video")) return "video";
  if (s.includes("wiki")) return "wikipedia";
  if (s.includes("ai_answer") || s.includes("ai-answer")) return "ai_answer";
  return s || "organic";
}

export function cellKey(cell: SurfaceCellKey): string {
  return `${cell.region}|${cell.engine}|${cell.surface}`;
}

type ObsRow = Awaited<ReturnType<typeof listSerpObservationsForAuditRun>>[number];

function itemCell(item: RawInventoryItem): SurfaceCellKey {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  const surfaceRaw =
    String(meta.surface ?? item.evidenceType ?? "organic").toLowerCase() === "search_result"
      ? "organic"
      : String(meta.surface ?? item.evidenceType ?? "organic");
  return {
    region: mapRegionBucket(item.region),
    engine: mapEngineBucket(String(meta.engine ?? item.provider ?? "")),
    surface: mapSurfaceBucket(surfaceRaw),
  };
}

function rowToItem(row: ObsRow): RawInventoryItem | null {
  const surface = String(row.surface ?? "organic").toLowerCase();
  const region = mapRegionBucket(row.region);
  const key = observationKey({
    auditRunId: row.auditRunId,
    provider: row.provider,
    engine: row.engine,
    region: row.region,
    language: row.language,
    surface: row.surface,
    queryId: row.queryId,
    rank: row.rank,
    normalizedUrlOrHash: valueHash(row.url, row.title),
  });

  if (surface === "organic") {
    return {
      inventoryId: `serp-obs-${row.id}`,
      caseId: row.caseId,
      reportRunId: row.auditRunId,
      source: "serp_observation",
      provider: String(row.provider ?? row.engine ?? "search").toUpperCase(),
      region,
      query: row.queryText,
      collectedAt: row.capturedAt.toISOString(),
      evidenceType: "search_result",
      title: String(row.title ?? "").trim() || row.url,
      snippet: row.snippet ?? "",
      sourceUrl: row.url,
      classification: undefined,
      rawMetadata: {
        serpObservationId: row.id,
        queryId: row.queryId,
        queryText: row.queryText,
        provider: row.provider,
        engine: row.engine,
        surface: row.surface,
        language: row.language,
        rank: row.rank,
        providerStatus: row.providerStatus,
        capturedAt: row.capturedAt.toISOString(),
        observationKey: key,
        evidenceRefs: [`serp_observation:${row.id}`],
        provenanceStatus: row.provider === "arsenkin" ? "arsenkin" : "run_scoped",
      },
    };
  }

  if (
    surface === "autocomplete" ||
    surface === "paa" ||
    surface === "related" ||
    surface === "ai_answer" ||
    surface === "page_meta" ||
    surface === "indexation"
  ) {
    const evidenceType =
      surface === "autocomplete"
        ? "suggestion"
        : surface === "ai_answer"
          ? "ai_answer"
          : surface === "page_meta"
            ? "page_meta"
            : surface === "indexation"
              ? "indexation"
              : "related_query";
    const line = String(row.title ?? row.queryText ?? "").trim();
    if (!line) return null;
    return {
      inventoryId: `serp-obs-${row.id}`,
      caseId: row.caseId,
      reportRunId: row.auditRunId,
      source: "serp_observation",
      provider: String(row.engine ?? row.provider ?? "search").toLowerCase(),
      region,
      query: line,
      collectedAt: row.capturedAt.toISOString(),
      evidenceType,
      title: line,
      snippet: row.snippet ?? "",
      sourceUrl: row.url,
      classification: undefined,
      rawMetadata: {
        serpObservationId: row.id,
        queryId: row.queryId,
        queryText: row.queryText,
        provider: row.provider,
        engine: row.engine,
        surface: row.surface,
        language: row.language,
        rank: row.rank,
        providerStatus: row.providerStatus,
        capturedAt: row.capturedAt.toISOString(),
        observationKey: key,
        evidenceRefs: [`serp_observation:${row.id}`],
        provenanceStatus: row.provider === "arsenkin" ? "arsenkin" : "run_scoped",
        arsenkinTool:
          surface === "paa"
            ? "paa"
            : surface === "autocomplete"
              ? "suggest"
              : surface === "ai_answer"
                ? "ai-serp"
                : surface === "page_meta"
                  ? "check-h"
                  : surface === "indexation"
                    ? "indexation"
                    : "related",
        notKnowledgePanel: surface === "ai_answer" ? true : undefined,
      },
    };
  }
  return null;
}

function coveredCellsFromRows(rows: ObsRow[]): Map<string, CoveredSurfaceCell & { count: number }> {
  const map = new Map<string, CoveredSurfaceCell & { count: number }>();
  for (const row of rows) {
    const cell: CoveredSurfaceCell = {
      region: mapRegionBucket(row.region),
      engine: mapEngineBucket(String(row.engine ?? "")),
      surface: mapSurfaceBucket(String(row.surface ?? "organic")),
    };
    const k = cellKey(cell);
    const prev = map.get(k);
    if (prev) prev.count += 1;
    else map.set(k, { ...cell, count: 1, status: "COLLECTED" });
  }
  return map;
}

function countKinds(items: RawInventoryItem[]): {
  searchResults: number;
  suggestions: number;
  related: number;
} {
  return {
    searchResults: items.filter((i) => i.evidenceType === "search_result").length,
    suggestions: items.filter((i) => /suggestion|autocomplete/i.test(i.evidenceType)).length,
    related: items.filter((i) => /related|paa/i.test(i.evidenceType)).length,
  };
}

function isSerpLike(item: RawInventoryItem): boolean {
  const et = item.evidenceType.toLowerCase();
  return (
    et === "search_result" ||
    et.includes("suggestion") ||
    et.includes("autocomplete") ||
    et.includes("related") ||
    et === "paa" ||
    et.includes("ai_answer") ||
    et.includes("page_meta") ||
    et.includes("indexation")
  );
}

/**
 * Overlay enrichment observations onto base inventory by coverage cell.
 * Uncovered cells keep base items with their original reportRunId.
 */
export function overlayInventoryByCoverageCells(input: {
  baseInventory: FullEvidenceInventory;
  enrichmentItems: RawInventoryItem[];
  coveredCells: Map<string, CoveredSurfaceCell & { count: number }>;
  baseReportRunId: string | null;
  enrichmentRunIds: string[];
}): CompositeMergeResult {
  const warnings: string[] = [...(input.baseInventory.warnings ?? [])];
  const before = countKinds(input.baseInventory.items);
  const ownership: CompositeSurfaceOwnership[] = [];
  const replacedKeys = new Set<string>();

  for (const [k, cell] of input.coveredCells) {
    replacedKeys.add(k);
    ownership.push({
      region: cell.region,
      engine: cell.engine,
      surface: cell.surface,
      owner: "enrichment",
      reportRunId: input.enrichmentRunIds[0] ?? "enrichment",
      provider: "arsenkin",
      observationCount: cell.count,
      sampleStatus: cell.count > 0 ? "MEASURED" : "NOT_COLLECTED",
    });
  }

  const keptBase: RawInventoryItem[] = [];
  const preservedCellKeys = new Set<string>();
  for (const item of input.baseInventory.items) {
    if (!isSerpLike(item)) {
      keptBase.push(item);
      continue;
    }
    const cell = itemCell(item);
    const k = cellKey(cell);
    if (replacedKeys.has(k)) {
      // Dropped — enrichment owns this cell.
      continue;
    }
    preservedCellKeys.add(k);
    const meta = { ...(item.rawMetadata ?? {}) } as Record<string, unknown>;
    if (!meta.provenanceStatus) meta.provenanceStatus = "inherited_base";
    keptBase.push({ ...item, rawMetadata: meta });
  }

  for (const k of preservedCellKeys) {
    const [region, engine, surface] = k.split("|");
    ownership.push({
      region,
      engine,
      surface,
      owner: "base",
      reportRunId: input.baseReportRunId ?? "base",
      observationCount: input.baseInventory.items.filter((i) => cellKey(itemCell(i)) === k).length,
      sampleStatus:
        input.baseInventory.items.filter((i) => cellKey(itemCell(i)) === k).length > 0
          ? "MEASURED"
          : "NOT_COLLECTED",
    });
  }

  // Deduplicate enrichment within each cell only.
  const seenInCell = new Map<string, Set<string>>();
  const duplicateKeys: string[] = [];
  const enrichmentDeduped: RawInventoryItem[] = [];
  for (const item of input.enrichmentItems) {
    const cell = itemCell(item);
    const ck = cellKey(cell);
    const obsKey = String((item.rawMetadata as { observationKey?: string } | undefined)?.observationKey ?? item.inventoryId);
    const set = seenInCell.get(ck) ?? new Set<string>();
    if (set.has(obsKey)) {
      duplicateKeys.push(obsKey);
      continue;
    }
    set.add(obsKey);
    seenInCell.set(ck, set);
    enrichmentDeduped.push(item);
  }

  const mergedItems = [...keptBase, ...enrichmentDeduped];
  const after = countKinds(mergedItems);

  // Detect unexpected loss of organic when enrichment did not cover organic.
  const enrichmentCoversOrganic = [...input.coveredCells.values()].some((c) => c.surface === "organic");
  if (!enrichmentCoversOrganic && before.searchResults > 0 && after.searchResults === 0) {
    warnings.push("uncovered-surface-data-loss:organic");
  }
  const enrichmentCoversUaeSuggest = [...input.coveredCells.values()].some(
    (c) => c.region === "UAE" && c.surface === "autocomplete"
  );
  if (
    !enrichmentCoversUaeSuggest &&
    input.baseInventory.items.some(
      (i) => isSerpLike(i) && mapRegionBucket(i.region) === "UAE" && /suggestion|autocomplete/i.test(i.evidenceType)
    ) &&
    !mergedItems.some(
      (i) => mapRegionBucket(i.region) === "UAE" && /suggestion|autocomplete/i.test(i.evidenceType)
    )
  ) {
    warnings.push("uncovered-surface-data-loss:uae-autocomplete");
  }

  const provenance: CompositeMergeProvenance = {
    version: "composite-serp-merge-v1",
    baseReportRunId: input.baseReportRunId,
    enrichmentRunIds: input.enrichmentRunIds,
    ownership,
    countsBefore: before,
    countsAfter: after,
    replacedCells: replacedKeys.size,
    preservedCells: preservedCellKeys.size,
    warnings: [...warnings],
  };

  const suggestionCount = after.suggestions;
  const relatedCount = after.related;

  const merged: FullEvidenceInventory = {
    ...input.baseInventory,
    warnings: [
      ...warnings,
      ...(duplicateKeys.length ? [`duplicate-observation-keys:${duplicateKeys.length}`] : []),
      ...(enrichmentDeduped.length ? [`composite-enrichment-merged:${enrichmentDeduped.length}`] : []),
    ],
    items: mergedItems,
    counts: {
      ...input.baseInventory.counts,
      searchResults: after.searchResults,
    },
    countsByEvidenceType: {
      ...input.baseInventory.countsByEvidenceType,
      search_result: after.searchResults,
      suggestion: suggestionCount,
      related_query: relatedCount,
    },
    mediaAvailability: {
      ...input.baseInventory.mediaAvailability,
      suggestions: suggestionCount,
      relatedQueries: relatedCount,
    },
  };

  return {
    inventory: merged,
    observationCount: enrichmentDeduped.length,
    duplicateKeys,
    usedRunScoped: enrichmentDeduped.length > 0 || Boolean(input.baseReportRunId),
    warnings: merged.warnings,
    provenance,
  };
}

export async function mergeCompositeSerpObservations(input: {
  inventory: FullEvidenceInventory;
  /** Primary / effective run (often Arsenkin after transfer). */
  auditRunId: string | undefined;
  binding?: ArsenkinReportBindingV2 | null;
  /** Explicit base observations (tests). */
  baseRows?: ObsRow[];
  enrichmentRows?: ObsRow[];
  env?: NodeJS.ProcessEnv;
}): Promise<CompositeMergeResult> {
  const composite = input.binding ? toCompositeBindingModel(input.binding) : null;
  const enrichmentRunId =
    composite?.enrichmentRuns[0]?.reportRunId ??
    (String(input.auditRunId ?? "").startsWith("orion-arsenkin-")
      ? String(input.auditRunId)
      : null);
  const baseReportRunId =
    composite?.sourceReportRunId ??
    (enrichmentRunId && enrichmentRunId !== input.auditRunId
      ? String(input.auditRunId ?? "")
      : enrichmentRunId
        ? composite?.sourceReportRunId ?? null
        : String(input.auditRunId ?? "").trim() || null);

  let enrichmentRows: ObsRow[] = input.enrichmentRows ?? [];
  let baseRows: ObsRow[] = input.baseRows ?? [];

  if (!input.enrichmentRows && enrichmentRunId) {
    try {
      enrichmentRows = await listSerpObservationsForAuditRun(enrichmentRunId);
    } catch (err) {
      return {
        inventory: input.inventory,
        observationCount: 0,
        duplicateKeys: [],
        usedRunScoped: false,
        warnings: [`enrichment-load-failed:${String((err as Error)?.message ?? err)}`],
        provenance: {
          version: "composite-serp-merge-v1",
          baseReportRunId,
          enrichmentRunIds: enrichmentRunId ? [enrichmentRunId] : [],
          ownership: [],
          countsBefore: countKinds(input.inventory.items),
          countsAfter: countKinds(input.inventory.items),
          replacedCells: 0,
          preservedCells: 0,
          warnings: [`enrichment-load-failed`],
        },
      };
    }
  }

  // Load base run-scoped organic when binding provides a distinct source run.
  if (
    !input.baseRows &&
    baseReportRunId &&
    enrichmentRunId &&
    baseReportRunId !== enrichmentRunId
  ) {
    try {
      baseRows = await listSerpObservationsForAuditRun(baseReportRunId);
    } catch {
      // Keep inventory legacy items as base.
      baseRows = [];
    }
  }

  // If no enrichment at all, fall back to treating auditRunId as a normal run-scoped merge source.
  if (!enrichmentRunId || enrichmentRows.length === 0) {
    const onlyRun = String(input.auditRunId ?? "").trim();
    if (!onlyRun) {
      return {
        inventory: input.inventory,
        observationCount: 0,
        duplicateKeys: [],
        usedRunScoped: false,
        warnings: [...(input.inventory.warnings ?? [])],
        provenance: {
          version: "composite-serp-merge-v1",
          baseReportRunId: null,
          enrichmentRunIds: [],
          ownership: [],
          countsBefore: countKinds(input.inventory.items),
          countsAfter: countKinds(input.inventory.items),
          replacedCells: 0,
          preservedCells: 0,
          warnings: [],
        },
      };
    }
    // Non-composite path handled by caller wrapper when enrichment absent.
  }

  const enrichmentItems = enrichmentRows
    .map(rowToItem)
    .filter((x): x is RawInventoryItem => Boolean(x));
  const covered = coveredCellsFromRows(enrichmentRows);

  // Prefer base run-scoped organic items when available; else keep inventory SERP as base.
  let baseInventory = input.inventory;
  if (baseRows.length > 0) {
    const baseItems = baseRows.map(rowToItem).filter((x): x is RawInventoryItem => Boolean(x));
    const nonSerp = input.inventory.items.filter((i) => !isSerpLike(i));
    baseInventory = {
      ...input.inventory,
      items: [...baseItems, ...nonSerp],
    };
  }

  // Mark remaining inventory SERP as legacy if we never loaded base observations.
  if (baseRows.length === 0) {
    baseInventory = {
      ...baseInventory,
      items: baseInventory.items.map((i) => {
        if (!isSerpLike(i)) return i;
        const meta = { ...(i.rawMetadata ?? {}) } as Record<string, unknown>;
        if (!meta.provenanceStatus) meta.provenanceStatus = "legacy_case_snapshot";
        return { ...i, rawMetadata: meta };
      }),
    };
  }

  return overlayInventoryByCoverageCells({
    baseInventory,
    enrichmentItems,
    coveredCells: covered,
    baseReportRunId: baseReportRunId && baseReportRunId !== enrichmentRunId ? baseReportRunId : null,
    enrichmentRunIds: enrichmentRunId ? [enrichmentRunId] : [],
  });
}
