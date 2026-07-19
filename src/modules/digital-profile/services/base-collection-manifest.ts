/**
 * Capture exact SearchResult / SearchSurfaceItem IDs for a unified job snapshot.
 * Composite merge must use ONLY this manifest — never "latest" case rows.
 *
 * REMEDIATION §1.1 / F5: the manifest stores the run delta plus the rest of the
 * case corpus so a partial re-collection never shrinks the report.
 */

import type { PrismaClient } from "@prisma/client";
import type {
  ActualProviderRecord,
  BaseCollectionManifest,
} from "./unified-collection-types";
import type { FullAuditResultDTO } from "./agent-run-service";

export function mapFullAuditToActualProviders(audit: FullAuditResultDTO): ActualProviderRecord[] {
  return audit.runSummary.map((item) => ({
    providerId: item.providerId,
    agentName: item.agentName,
    runtime: item.runtime,
    status: item.status,
    reason: item.reason,
  }));
}

/** Required collection providers must complete as real for REPORT_READY honesty. */
export function isRealCollectionSufficient(providers: ActualProviderRecord[]): boolean {
  const required = ["yandex", "google", "orion_profile"];
  for (const id of required) {
    const row = providers.find((p) => p.providerId === id);
    if (!row) continue;
    if (row.status === "skipped" || row.status === "unavailable") continue;
    if (row.status === "failed") return false;
    if (row.runtime === "mock" || row.runtime === "none") return false;
  }
  // At least one of yandex/google/orion_profile must have completed as real
  const collectionOk = providers.some(
    (p) =>
      (p.providerId === "yandex" || p.providerId === "google" || p.providerId === "orion_profile") &&
      p.status === "completed" &&
      p.runtime === "real"
  );
  return collectionOk;
}

export async function captureBaseCollectionManifest(input: {
  prisma: PrismaClient;
  caseId: string;
  unifiedJobId: string;
  beforeSearchResultIds: Set<string>;
  beforeSearchSurfaceItemIds: Set<string>;
  actualProviders: ActualProviderRecord[];
  baseReportRunId?: string | null;
}): Promise<BaseCollectionManifest> {
  const results = await input.prisma.searchResult.findMany({
    where: { caseId: input.caseId },
    select: { id: true },
  });
  const surfaces = await input.prisma.searchSurfaceItem.findMany({
    where: { caseId: input.caseId },
    select: { id: true },
  });

  const afterResultIds = results.map((r) => r.id);
  const afterSurfaceIds = surfaces.map((s) => s.id);

  const deltaResultIds = afterResultIds.filter((id) => !input.beforeSearchResultIds.has(id));
  const deltaSurfaceIds = afterSurfaceIds.filter((id) => !input.beforeSearchSurfaceItemIds.has(id));

  // If diff empty (re-run / upsert), fall back to all current IDs tagged by capture window —
  // still explicit IDs, not "latest report run". Prefer AFTER set when diff is empty.
  const searchResultIds = deltaResultIds.length > 0 ? deltaResultIds : afterResultIds;
  const searchSurfaceItemIds = deltaSurfaceIds.length > 0 ? deltaSurfaceIds : afterSurfaceIds;

  const deltaResultSet = new Set(searchResultIds);
  const deltaSurfaceSet = new Set(searchSurfaceItemIds);
  const caseCorpusSearchResultIds = afterResultIds.filter((id) => !deltaResultSet.has(id));
  const caseCorpusSurfaceItemIds = afterSurfaceIds.filter((id) => !deltaSurfaceSet.has(id));

  const actualProviders = input.actualProviders;
  return {
    version: "base-collection-manifest-v1",
    unifiedJobId: input.unifiedJobId,
    caseId: input.caseId,
    capturedAt: new Date().toISOString(),
    baseReportRunId: input.baseReportRunId ?? null,
    searchResultIds,
    searchSurfaceItemIds,
    caseCorpusSearchResultIds,
    caseCorpusSurfaceItemIds,
    baseCount:
      searchResultIds.length +
      searchSurfaceItemIds.length +
      caseCorpusSearchResultIds.length +
      caseCorpusSurfaceItemIds.length,
    actualProviders,
    realCollectionSufficient: isRealCollectionSufficient(actualProviders),
  };
}

export async function snapshotExistingIds(
  prisma: PrismaClient,
  caseId: string
): Promise<{ searchResultIds: Set<string>; searchSurfaceItemIds: Set<string> }> {
  const [results, surfaces] = await Promise.all([
    prisma.searchResult.findMany({ where: { caseId }, select: { id: true } }),
    prisma.searchSurfaceItem.findMany({ where: { caseId }, select: { id: true } }),
  ]);
  return {
    searchResultIds: new Set(results.map((r) => r.id)),
    searchSurfaceItemIds: new Set(surfaces.map((s) => s.id)),
  };
}
