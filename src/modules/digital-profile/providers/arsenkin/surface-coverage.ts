import { prisma } from "@/server/prisma/client";
import type { SerpObservationDraft } from "../../serp-observation/types";

export type SurfaceCoverageInput = {
  reportRunId: string;
  provider: string;
  tool: string;
  providerTaskId?: string | null;
  queryId: string;
  queryText: string;
  engine: string;
  region: string;
  language: string;
  device?: string;
  surface: string;
  resultCount: number;
  errorCode?: string | null;
  capturedAt?: Date;
};

const bizKey = (input: SurfaceCoverageInput) => ({
  reportRunId: input.reportRunId,
  provider: input.provider,
  tool: input.tool,
  queryId: input.queryId,
  surface: input.surface,
  engine: input.engine,
  region: input.region,
  language: input.language,
  device: input.device ?? "DESKTOP",
});

/** Atomic upsert on composite business key (no findFirst → create race). */
export async function upsertSurfaceCollectionCoverage(input: SurfaceCoverageInput) {
  const where = bizKey(input);
  const data = {
    ...where,
    providerTaskId: input.providerTaskId ?? null,
    queryText: input.queryText,
    status: input.resultCount > 0 ? "OK" : "NO_RESULTS",
    resultCount: input.resultCount,
    errorCode: input.errorCode ?? null,
    capturedAt: input.capturedAt ?? new Date(),
  };
  return prisma.surfaceCollectionCoverage.upsert({
    where: {
      reportRunId_provider_tool_queryId_surface_engine_region_language_device: where,
    },
    create: data,
    update: {
      providerTaskId: data.providerTaskId,
      queryText: data.queryText,
      status: data.status,
      resultCount: data.resultCount,
      errorCode: data.errorCode,
      capturedAt: data.capturedAt,
    },
  });
}

export async function recordSurfaceCoverageFromDrafts(input: {
  reportRunId: string;
  tool: string;
  providerTaskId?: string | null;
  drafts: SerpObservationDraft[];
}) {
  const groups = new Map<string, SerpObservationDraft[]>();
  for (const draft of input.drafts) {
    const key = [
      draft.queryId,
      draft.engine,
      draft.region,
      draft.language,
      draft.device ?? "DESKTOP",
      draft.surface,
    ].join("|");
    groups.set(key, [...(groups.get(key) ?? []), draft]);
  }
  return Promise.all(
    [...groups.values()].map((rows) => {
      const first = rows[0]!;
      return upsertSurfaceCollectionCoverage({
        reportRunId: input.reportRunId,
        provider: first.provider,
        tool: input.tool,
        providerTaskId: input.providerTaskId ?? first.providerTaskId ?? null,
        queryId: first.queryId,
        queryText: first.queryText,
        engine: first.engine,
        region: first.region,
        language: first.language,
        device: first.device,
        surface: first.surface,
        resultCount: rows.filter((row) => row.providerStatus === "OK").length,
        capturedAt: first.capturedAt,
      });
    })
  );
}
