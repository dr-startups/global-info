/**
 * Persist (or idempotently reuse) the OrionReportRun that owns a unified job's
 * base Yandex/Serper/Wikipedia collection. Arsenkin CaseAgents and binding
 * require a real DB row — never a synthetic id.
 */

import type { PrismaClient } from "@prisma/client";

export const UNIFIED_BASE_REPORT_MODE = "UNIFIED_BASE_COLLECTION";

export type EnsureUnifiedBaseReportRunResult = {
  baseReportRunId: string;
  created: boolean;
};

/**
 * Find an existing base run for this unifiedJobId or create one.
 * Idempotent: repeated calls with the same caseId+unifiedJobId return the same id.
 */
export async function ensurePersistedUnifiedBaseReportRun(input: {
  prisma: PrismaClient;
  caseId: string;
  unifiedJobId: string;
  /** Prefer reusing this id when it already exists for the case. */
  existingBaseReportRunId?: string | null;
}): Promise<EnsureUnifiedBaseReportRunResult> {
  const existingId = String(input.existingBaseReportRunId ?? "").trim();
  if (existingId) {
    const row = await input.prisma.orionReportRun.findFirst({
      where: { id: existingId, caseId: input.caseId },
      select: { id: true },
    });
    if (row) return { baseReportRunId: row.id, created: false };
  }

  const byMeta = await input.prisma.orionReportRun.findMany({
    where: {
      caseId: input.caseId,
      mode: UNIFIED_BASE_REPORT_MODE,
    },
    select: { id: true, metadataJson: true },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  for (const row of byMeta) {
    const meta = (row.metadataJson ?? {}) as Record<string, unknown>;
    if (meta.unifiedJobId === input.unifiedJobId) {
      return { baseReportRunId: row.id, created: false };
    }
  }

  const id = `orion-unified-base-${input.unifiedJobId}`.slice(0, 190);
  await input.prisma.orionReportRun.create({
    data: {
      id,
      caseId: input.caseId,
      mode: UNIFIED_BASE_REPORT_MODE,
      status: "SUCCEEDED",
      storeMode: "file",
      internalOnly: true,
      startedAt: new Date(),
      finishedAt: new Date(),
      metadataJson: {
        unifiedJobId: input.unifiedJobId,
        purpose: "unified-base-collection",
        createdBy: "ensurePersistedUnifiedBaseReportRun",
      },
    },
  });
  return { baseReportRunId: id, created: true };
}

/** Normalize SERP engine/provider labels to binding buckets. */
export function normalizeSerpProviderBucket(
  engineOrProvider: string | null | undefined
): "yandex" | "serper" | "base" {
  const e = String(engineOrProvider ?? "")
    .trim()
    .toUpperCase();
  if (!e) return "base";
  if (e.includes("YANDEX")) return "yandex";
  if (e.includes("GOOGLE") || e.includes("SERPER")) return "serper";
  return "base";
}
