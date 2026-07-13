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

  for (const row of rows) {
    if (String(row.surface ?? "organic") !== "organic") continue;
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
  }

  const nonSearch = input.inventory.items.filter((i) => i.evidenceType !== "search_result");
  const legacySearch = input.inventory.items.filter((i) => i.evidenceType === "search_result");
  const keepLegacy = !requireRunScoped && obsItems.length === 0;
  const searchItems = keepLegacy ? legacySearch : obsItems;

  if (requireRunScoped && obsItems.length === 0) {
    warnings.push("run-scoped-required-but-no-organic-observations");
  }

  const merged: FullEvidenceInventory = {
    ...input.inventory,
    warnings: [...warnings, ...(duplicateKeys.length ? [`duplicate-observation-keys:${duplicateKeys.length}`] : [])],
    items: [...searchItems, ...nonSearch],
    counts: {
      ...input.inventory.counts,
      searchResults: searchItems.length,
    },
    countsByEvidenceType: {
      ...input.inventory.countsByEvidenceType,
      search_result: searchItems.length,
    },
  };

  return {
    inventory: merged,
    observationCount: obsItems.length,
    duplicateKeys,
    usedRunScoped: !keepLegacy && obsItems.length > 0,
    warnings: merged.warnings,
  };
}
