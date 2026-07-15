/**
 * Merge run-scoped SerpObservation rows into FullEvidenceInventory for First36 KPI/tables.
 *
 * When an Arsenkin composite binding is present, uses surface-aware overlay merge so
 * SUGGEST_RU_CANARY enrichment replaces only covered autocomplete cells and preserves
 * base organic / UAE / other surfaces.
 */

import { createHash } from "node:crypto";
import { listSerpObservationsForAuditRun } from "../../serp-observation";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { RawInventoryItem } from "../types";
import { observationKey } from "./client-language";
import { mustUseRunScopedSerpObservations } from "./first36-run-scoped-flags";
import {
  loadArsenkinReportBinding,
  toCompositeBindingModel,
} from "./arsenkin-report-binding";
import {
  mergeCompositeSerpObservations,
  type CompositeMergeProvenance,
} from "./composite-serp-overlay-merge";

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

function mapRegion(raw: string): string {
  const r = String(raw ?? "").toUpperCase();
  if (/UAE|AE|INTL|EN|GLOBAL_INTL/.test(r)) return "UAE";
  if (/RU|RUSSIA|RF/.test(r)) return "RU";
  return r || "RU";
}

export type RunScopedMergeResult = {
  inventory: FullEvidenceInventory;
  observationCount: number;
  duplicateKeys: string[];
  usedRunScoped: boolean;
  warnings: string[];
  compositeProvenance?: CompositeMergeProvenance;
};

export async function mergeRunScopedSerpObservations(input: {
  inventory: FullEvidenceInventory;
  auditRunId: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Optional caseId for composite binding lookup. */
  caseId?: string;
}): Promise<RunScopedMergeResult> {
  const env = input.env ?? process.env;
  const warnings: string[] = [...(input.inventory.warnings ?? [])];
  const requireRunScoped = mustUseRunScopedSerpObservations(env);
  const auditRunId = String(input.auditRunId ?? "").trim();
  const caseId = String(input.caseId ?? input.inventory.caseId ?? "").trim();

  // Composite path: Arsenkin transfer binding present → surface-aware overlay.
  const binding = caseId ? loadArsenkinReportBinding(caseId) : null;
  if (
    binding &&
    (binding.status === "TRANSFERRED" ||
      binding.status === "REPORT_BOUND" ||
      (binding.status === "TRANSFER_FAILED" &&
        binding.contentPromotionError === "CLIENT_CONTENT_NOT_PROMOTED"))
  ) {
    const composite = toCompositeBindingModel(binding);
    const result = await mergeCompositeSerpObservations({
      inventory: input.inventory,
      auditRunId: auditRunId || binding.effectiveReportRunId,
      binding: composite,
      env,
    });
    if (result.warnings.some((w) => w.startsWith("uncovered-surface-data-loss"))) {
      // Keep as warning artifact; acceptance gate may promote to blocker.
    }
    return {
      inventory: result.inventory,
      observationCount: result.observationCount,
      duplicateKeys: result.duplicateKeys,
      usedRunScoped: result.usedRunScoped,
      warnings: result.warnings,
      compositeProvenance: result.provenance,
    };
  }

  if (!auditRunId) {
    if (requireRunScoped) {
      warnings.push("run-scoped-required-but-auditRunId-missing");
    }
    return {
      inventory: input.inventory,
      observationCount: 0,
      duplicateKeys: [],
      usedRunScoped: false,
      warnings,
    };
  }

  let rows: Awaited<ReturnType<typeof listSerpObservationsForAuditRun>> = [];
  try {
    rows = await listSerpObservationsForAuditRun(auditRunId);
  } catch (err) {
    warnings.push(`serp-observation-load-failed:${String((err as Error)?.message ?? err)}`);
    if (requireRunScoped) {
      throw new Error(`FIRST36_RUN_SCOPED_OBSERVATIONS_REQUIRED:${auditRunId}`);
    }
    return {
      inventory: input.inventory,
      observationCount: 0,
      duplicateKeys: [],
      usedRunScoped: false,
      warnings,
    };
  }

  if (rows.length === 0) {
    if (requireRunScoped) {
      warnings.push("run-scoped-observations-empty");
      // Without composite binding, do NOT strip legacy organic solely because
      // the audit run has no observations — that was the canary data-loss bug.
      // Only strip when explicitly forced via env.
      if (env.ORION_FIRST36_STRIP_EMPTY_RUN === "1") {
        const stripped: FullEvidenceInventory = {
          ...input.inventory,
          warnings: [...warnings],
          items: input.inventory.items.filter((i) => i.evidenceType !== "search_result"),
          counts: { ...input.inventory.counts, searchResults: 0 },
          countsByEvidenceType: {
            ...input.inventory.countsByEvidenceType,
            search_result: 0,
          },
        };
        return {
          inventory: stripped,
          observationCount: 0,
          duplicateKeys: [],
          usedRunScoped: true,
          warnings: stripped.warnings,
        };
      }
      warnings.push("run-scoped-empty-preserving-base-inventory");
      return {
        inventory: { ...input.inventory, warnings },
        observationCount: 0,
        duplicateKeys: [],
        usedRunScoped: false,
        warnings,
      };
    }
    return {
      inventory: input.inventory,
      observationCount: 0,
      duplicateKeys: [],
      usedRunScoped: false,
      warnings,
    };
  }

  const seen = new Map<string, number>();
  const duplicateKeys: string[] = [];
  const obsItems: RawInventoryItem[] = [];
  const surfaceItems: RawInventoryItem[] = [];

  for (const row of rows) {
    const surface = String(row.surface ?? "organic").toLowerCase();
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
    const prev = seen.get(key) ?? 0;
    seen.set(key, prev + 1);
    if (prev > 0) {
      duplicateKeys.push(key);
      continue;
    }

    const region = mapRegion(row.region);
    if (surface === "organic") {
      obsItems.push({
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
        },
      });
      continue;
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
      if (!line) continue;
      surfaceItems.push({
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
      });
    }
  }

  const nonSearch = input.inventory.items.filter((i) => i.evidenceType !== "search_result");
  const legacySearch = input.inventory.items.filter((i) => i.evidenceType === "search_result");
  // Preserve base organic when this run only collected non-organic surfaces.
  const keepLegacyOrganic = obsItems.length === 0;
  const searchItems = keepLegacyOrganic ? legacySearch : obsItems;

  const hasArsenkinSuggest = surfaceItems.some((i) => i.evidenceType === "suggestion");
  const hasArsenkinRelated = surfaceItems.some((i) => i.evidenceType === "related_query");
  // Only replace suggestions in the same region as enrichment surfaces.
  const enrichmentSuggestRegions = new Set(
    surfaceItems.filter((i) => i.evidenceType === "suggestion").map((i) => mapRegion(i.region))
  );
  const keptNonSearch = nonSearch.filter((i) => {
    const et = i.evidenceType.toLowerCase();
    if (hasArsenkinSuggest && (et.includes("suggestion") || et.includes("autocomplete"))) {
      return !enrichmentSuggestRegions.has(mapRegion(i.region));
    }
    if (
      hasArsenkinRelated &&
      (et.includes("related") || et === "paa") &&
      !et.includes("search_result")
    ) {
      return false;
    }
    return true;
  });

  if (requireRunScoped && obsItems.length === 0 && surfaceItems.length > 0) {
    warnings.push("run-scoped-surfaces-only-preserving-base-organic");
  }

  const mergedItems = [...searchItems, ...surfaceItems, ...keptNonSearch];
  const suggestionCount = mergedItems.filter((i) =>
    /suggestion|autocomplete/i.test(i.evidenceType)
  ).length;
  const relatedCount = mergedItems.filter((i) => /related|paa/i.test(i.evidenceType)).length;

  const merged: FullEvidenceInventory = {
    ...input.inventory,
    warnings: [
      ...warnings,
      ...(duplicateKeys.length ? [`duplicate-observation-keys:${duplicateKeys.length}`] : []),
      ...(surfaceItems.length ? [`arsenkin-surfaces-merged:${surfaceItems.length}`] : []),
    ],
    items: mergedItems,
    counts: {
      ...input.inventory.counts,
      searchResults: searchItems.length,
    },
    countsByEvidenceType: {
      ...input.inventory.countsByEvidenceType,
      search_result: searchItems.length,
      suggestion: suggestionCount,
      related_query: relatedCount,
    },
    mediaAvailability: {
      ...input.inventory.mediaAvailability,
      suggestions: suggestionCount,
      relatedQueries: relatedCount,
    },
  };

  return {
    inventory: merged,
    observationCount: obsItems.length + surfaceItems.length,
    duplicateKeys,
    usedRunScoped: obsItems.length > 0 || surfaceItems.length > 0,
    warnings: merged.warnings,
  };
}
