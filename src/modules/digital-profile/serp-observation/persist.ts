import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import type { PersistedSerpObservation, SerpObservationDraft } from "./types";

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/**
 * Persist observation drafts for one audit run.
 * - Each draft becomes its own SerpObservation row (no cross-query URL dedupe).
 * - SearchDocument is upserted by (caseId, url) for canonical identity only.
 */
export async function persistSerpObservations(
  drafts: SerpObservationDraft[]
): Promise<PersistedSerpObservation[]> {
  if (drafts.length === 0) return [];

  const auditRunIds = new Set(drafts.map((d) => d.auditRunId));
  if (auditRunIds.size !== 1) {
    throw new Error(`persistSerpObservations: expected single auditRunId, got ${auditRunIds.size}`);
  }

  const out: PersistedSerpObservation[] = [];

  for (const draft of drafts) {
    const doc = await prisma.searchDocument.upsert({
      where: { caseId_url: { caseId: draft.caseId, url: draft.url } },
      create: {
        caseId: draft.caseId,
        url: draft.url,
        domain: draft.domain,
        title: draft.title,
      },
      update: {
        domain: draft.domain ?? undefined,
        title: draft.title ?? undefined,
      },
      select: { id: true },
    });

    const data = {
        caseId: draft.caseId,
        auditRunId: draft.auditRunId,
        queryId: draft.queryId,
        queryText: draft.queryText,
        parentQueryId: draft.parentQueryId ?? null,
        providerTaskId: draft.providerTaskId ?? null,
        provider: draft.provider,
        engine: draft.engine,
        device: draft.device ?? "DESKTOP",
        surface: draft.surface,
        region: draft.region,
        language: draft.language,
        rank: draft.rank,
        url: draft.url,
        title: draft.title,
        snippet: draft.snippet,
        domain: draft.domain,
        searchDocumentId: doc.id,
        providerStatus: draft.providerStatus,
        rawPayloadJson: draft.rawPayloadJson ? toJson(draft.rawPayloadJson) : undefined,
        capturedAt: draft.capturedAt,
      };
    const row = await prisma.serpObservation.upsert({
      where: {
        auditRunId_provider_engine_region_language_device_surface_queryId_rank_url: {
          auditRunId: draft.auditRunId,
          provider: draft.provider,
          engine: draft.engine,
          region: draft.region,
          language: draft.language,
          device: draft.device ?? "DESKTOP",
          surface: draft.surface,
          queryId: draft.queryId,
          rank: draft.rank,
          url: draft.url,
        },
      },
      create: data,
      update: data,
    });

    out.push({
      ...draft,
      id: row.id,
      searchDocumentId: row.searchDocumentId,
    });
  }

  return out;
}

export async function listSerpObservationsForAuditRun(auditRunId: string) {
  return prisma.serpObservation.findMany({
    where: { auditRunId },
    orderBy: [{ queryId: "asc" }, { rank: "asc" }],
  });
}
