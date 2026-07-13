/**
 * Merge run-scoped SerpObservation rows into FullEvidenceInventory for First36 KPI/tables.
 * Replaces case-wide search_result rows when observations are available.
 */

import { createHash } from "node:crypto";
import { listSerpObservationsForAuditRun } from "../../serp-observation";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { RawInventoryItem } from "../types";
import { observationKey } from "./client-language";
import { mustUseRunScopedSerpObservations } from "./first36-run-scoped-flags";

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
};

export async function mergeRunScopedSerpObservations(input: {
  inventory: FullEvidenceInventory;
  auditRunId: string | undefined;
  env?: NodeJS.ProcessEnv;
}): Promise<RunScopedMergeResult> {
  const env = input.env ?? process.env;
  const warnings: string[] = [...(input.inventory.warnings ?? [])];
  const requireRunScoped = mustUseRunScopedSerpObservations(env);
  const auditRunId = String(input.auditRunId ?? "").trim();

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
      // Strip case-wide search_result rows — do not silently reuse old runs.
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

    if (surface === "autocomplete" || surface === "paa" || surface === "related") {
      const evidenceType =
        surface === "autocomplete"
          ? "suggestion"
          : surface === "paa"
            ? "related_query"
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
          arsenkinTool: surface === "paa" ? "paa" : surface === "autocomplete" ? "suggest" : "related",
        },
      });
    }
  }

  const nonSearch = input.inventory.items.filter((i) => i.evidenceType !== "search_result");
  const legacySearch = input.inventory.items.filter((i) => i.evidenceType === "search_result");
  const keepLegacy = !requireRunScoped && obsItems.length === 0;
  const searchItems = keepLegacy ? legacySearch : obsItems;

  // Prefer Arsenkin suggestion/PAA when present; keep other non-search inventory.
  const hasArsenkinSuggest = surfaceItems.some((i) => i.evidenceType === "suggestion");
  const hasArsenkinRelated = surfaceItems.some((i) => i.evidenceType === "related_query");
  const keptNonSearch = nonSearch.filter((i) => {
    const et = i.evidenceType.toLowerCase();
    if (hasArsenkinSuggest && (et.includes("suggestion") || et.includes("autocomplete"))) {
      return false;
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

  if (requireRunScoped && obsItems.length === 0) {
    warnings.push("run-scoped-required-but-no-organic-observations");
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
    usedRunScoped: (!keepLegacy && obsItems.length > 0) || surfaceItems.length > 0,
    warnings: merged.warnings,
  };
}
