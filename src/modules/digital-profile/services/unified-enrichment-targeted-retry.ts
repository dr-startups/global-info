/**
 * Targeted paid retry for a single missing Arsenkin enrichment CaseAgent task
 * (typically SUGGESTIONS after SUBMIT_REJECTED_RETRYABLE / SUBMIT_UNKNOWN).
 * Never creates a new unified job / AgentRun / enrichmentRun / base collection.
 */

import { createHash, randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors";
import { ARSENKIN_REGION } from "../providers/arsenkin/regions";
import { tryBuildSuggestRequest } from "../providers/arsenkin/adapters/suggest";
import { hashProviderRequest } from "../providers/arsenkin/provider-task-store";
import { buildArsenkinSubjectQueryPlan } from "../orion-golden/classic/arsenkin-subject-query-plan";
import {
  claimUnifiedJobLease,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  releaseUnifiedJobLease,
  writeUnifiedArtifact,
} from "./unified-collection-job-store";
import type { UnifiedCollectionJob } from "./unified-collection-types";

export const PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED =
  "PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED" as const;

export type TargetedEnrichmentRetryAgent = "SUGGESTIONS" | "ARSENKIN_SUGGESTIONS_REAL";

export type TargetedEnrichmentRetryDeps = {
  /** Injected submit — tests fake; live wraps ensureArsenkinTask. */
  submitSuggestTask?: (input: {
    caseId: string;
    enrichmentRunId: string;
    requestJson: { tools_name: string; data: Record<string, unknown> };
    requestHash: string;
  }) => Promise<{ externalTaskId: string; providerTaskId: string }>;
  /** Load subject identity for query plan (offline fixture). */
  loadSubject?: (caseId: string) => Promise<{ fullName: string | null; aliases: string[] }>;
  /** Existing ProviderTasks for the enrichment run (offline fixture). */
  listProviderTasks?: (enrichmentRunId: string) => Promise<
    Array<{
      id: string;
      state: string;
      toolName: string | null;
      externalTaskId: string | null;
      requestHash?: string | null;
      responseJson?: unknown;
      requestJson?: unknown;
    }>
  >;
  now?: () => Date;
  autoSchedule?: boolean;
};

export type TargetedEnrichmentRetryResult = {
  accepted: true;
  jobId: string;
  unifiedJobId: string;
  enrichmentRunId: string;
  agentName: "ARSENKIN_SUGGESTIONS_REAL";
  externalTaskId: string;
  providerTaskId: string;
  requestHash: string;
  submissions: number;
  reusedExisting: boolean;
  stage: string;
  status: "WAITING";
  resumeCheckpoint: "ARSENKIN_RESULT_INGEST";
};

function normalizeAgentName(raw: string): "ARSENKIN_SUGGESTIONS_REAL" {
  const t = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (t === "SUGGESTIONS" || t === "ARSENKIN_SUGGESTIONS_REAL") {
    return "ARSENKIN_SUGGESTIONS_REAL";
  }
  throw new ValidationError(`unsupported agentName for targeted retry: ${raw}`);
}

function taskFingerprint(input: {
  enrichmentRunId: string;
  agentName: string;
  requestHash: string;
}): string {
  return createHash("sha256")
    .update(`${input.enrichmentRunId}|${input.agentName}|${input.requestHash}`)
    .digest("hex");
}

function isIngestibleResponse(responseJson: unknown): boolean {
  if (responseJson == null || typeof responseJson !== "object") return false;
  const o = responseJson as Record<string, unknown>;
  if (o._submitDiagnostics) return false;
  if (Array.isArray(o.items) || Array.isArray(o.results) || Array.isArray(o.suggestions)) {
    return true;
  }
  if (o.result != null || o.types != null) return true;
  return false;
}

function findSuggestionsEnrichmentRunId(job: UnifiedCollectionJob): string | null {
  const ids = job.enrichmentRunIds ?? [];
  const hit = ids.find((id) => /suggestions/i.test(id));
  return hit ?? null;
}

/**
 * Server-side targeted retry for missing SUGGESTIONS enrichment task.
 */
export async function retryUnifiedEnrichmentSuggestionsTask(input: {
  caseId: string;
  jobId: string;
  enrichmentRunId: string;
  agentName: string;
  expectedTaskFingerprint?: string | null;
  confirmPaidEnrichmentRetry: boolean;
  actorId: string;
  deps?: TargetedEnrichmentRetryDeps;
}): Promise<TargetedEnrichmentRetryResult> {
  const jobId = String(input.jobId ?? "").trim();
  const enrichmentRunId = String(input.enrichmentRunId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");
  if (!enrichmentRunId) throw new ValidationError("enrichmentRunId is required");
  const agentName = normalizeAgentName(input.agentName);

  const job = loadUnifiedCollectionJob(input.caseId);
  if (!job) throw new NotFoundError("unified collection job not found");
  if (job.jobId !== jobId && job.unifiedJobId !== jobId) {
    throw new NotFoundError("jobId does not belong to this case");
  }
  if (!job.enrichmentRunIds?.includes(enrichmentRunId)) {
    throw new ConflictError("ENRICHMENT_RUN_NOT_ON_JOB");
  }
  const expectedSuggestionsRun = findSuggestionsEnrichmentRunId(job);
  if (expectedSuggestionsRun && expectedSuggestionsRun !== enrichmentRunId) {
    throw new ConflictError("ENRICHMENT_RUN_NOT_SUGGESTIONS");
  }

  const ownerId = `enrichment-retry-${process.pid}-${randomUUID().slice(0, 6)}`;
  const claimed = claimUnifiedJobLease({
    caseId: input.caseId,
    ownerId,
    leaseMs: 120_000,
    now: input.deps?.now?.(),
  });
  if (!claimed) throw new ConflictError("ACTIVE_LEASE");

  try {
    const tasks =
      (await input.deps?.listProviderTasks?.(enrichmentRunId)) ??
      (await defaultListProviderTasks(enrichmentRunId));

    const suggestTasks = tasks.filter((t) => /suggest/i.test(String(t.toolName ?? "")));
    const reusable = suggestTasks.find(
      (t) =>
        Boolean(t.externalTaskId) ||
        String(t.state).toUpperCase() === "DONE" ||
        isIngestibleResponse(t.responseJson)
    );
    if (reusable?.externalTaskId) {
      writeUnifiedArtifact(input.caseId, job.unifiedJobId, "enrichment-targeted-retry-audit.json", {
        version: "enrichment-targeted-retry-audit-v1",
        at: (input.deps?.now ?? (() => new Date()))().toISOString(),
        actorId: input.actorId,
        jobId,
        enrichmentRunId,
        agentName,
        reusedExisting: true,
        externalTaskId: reusable.externalTaskId,
        providerTaskId: reusable.id,
        submissions: 0,
      });
      patchUnifiedCollectionJob(input.caseId, {
        stage: "ARSENKIN_ENRICHMENT",
        status: "WAITING",
        resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        warnings: [
          ...job.warnings.filter((w) => !/^targeted-retry:/i.test(w)),
          "targeted-retry:reused-existing-suggestions-task",
        ],
      });
      return {
        accepted: true,
        jobId: job.jobId,
        unifiedJobId: job.unifiedJobId,
        enrichmentRunId,
        agentName,
        externalTaskId: reusable.externalTaskId,
        providerTaskId: reusable.id,
        requestHash: String(reusable.requestHash ?? ""),
        submissions: 0,
        reusedExisting: true,
        stage: "ARSENKIN_ENRICHMENT",
        status: "WAITING",
        resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      };
    }

    if (!input.confirmPaidEnrichmentRetry) {
      throw new ConflictError(PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED);
    }

    const subject =
      (await input.deps?.loadSubject?.(input.caseId)) ??
      (await defaultLoadSubject(input.caseId));
    const qp = buildArsenkinSubjectQueryPlan({
      fullName: subject.fullName,
      aliases: subject.aliases,
    });
    // Primary targeted retry: Yandex RU suggest (Cyrillic) — one submission.
    const built = tryBuildSuggestRequest({
      queries: qp.queriesRu.length > 0 ? qp.queriesRu : qp.queriesUae,
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      depth: 1,
    });
    if (!built.ok) {
      throw new ConflictError(`SUGGEST_REQUEST_INVALID:${built.message}`);
    }
    const requestJson = built.request;
    const requestHash = hashProviderRequest(requestJson);
    const fingerprint = taskFingerprint({ enrichmentRunId, agentName, requestHash });
    if (
      input.expectedTaskFingerprint &&
      String(input.expectedTaskFingerprint).trim() &&
      String(input.expectedTaskFingerprint).trim() !== fingerprint
    ) {
      throw new ConflictError("TASK_FINGERPRINT_MISMATCH");
    }

    const submit =
      input.deps?.submitSuggestTask ??
      (async (args) => {
        // Offline / NETWORK_CALLS=0 must never open Arsenkin transport.
        if (process.env.NETWORK_CALLS === "0") {
          throw new ConflictError("SUBMIT_TRANSPORT_UNAVAILABLE");
        }
        return defaultSubmitSuggestTask(args);
      });

    const submitted = await submit({
      caseId: input.caseId,
      enrichmentRunId,
      requestJson,
      requestHash,
    });

    writeUnifiedArtifact(input.caseId, job.unifiedJobId, "enrichment-targeted-retry-audit.json", {
      version: "enrichment-targeted-retry-audit-v1",
      at: (input.deps?.now ?? (() => new Date()))().toISOString(),
      actorId: input.actorId,
      jobId,
      enrichmentRunId,
      agentName,
      reusedExisting: false,
      externalTaskId: submitted.externalTaskId,
      providerTaskId: submitted.providerTaskId,
      requestHash,
      taskFingerprint: fingerprint,
      submissions: 1,
      confirmPaidEnrichmentRetry: true,
    });

    patchUnifiedCollectionJob(input.caseId, {
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      lastError: null,
      lastErrorCode: null,
      completedAt: null,
      arsenkinEnrichmentState: job.arsenkinEnrichmentState
        ? { ...job.arsenkinEnrichmentState, enrichmentComplete: false }
        : job.arsenkinEnrichmentState,
      warnings: [
        ...job.warnings.filter((w) => !/^targeted-retry:/i.test(w)),
        "targeted-retry:suggestions-submitted:1",
        `targeted-retry:externalTaskId:${submitted.externalTaskId}`,
      ],
    });

    return {
      accepted: true,
      jobId: job.jobId,
      unifiedJobId: job.unifiedJobId,
      enrichmentRunId,
      agentName,
      externalTaskId: submitted.externalTaskId,
      providerTaskId: submitted.providerTaskId,
      requestHash,
      submissions: 1,
      reusedExisting: false,
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
    };
  } finally {
    releaseUnifiedJobLease(input.caseId, ownerId);
  }
}

async function defaultSubmitSuggestTask(input: {
  caseId: string;
  enrichmentRunId: string;
  requestJson: { tools_name: string; data: Record<string, unknown> };
  requestHash: string;
}): Promise<{ externalTaskId: string; providerTaskId: string }> {
  const { createArsenkinClientFromEnv } = await import("../providers/arsenkin/client");
  const { createPrismaProviderTaskStore } = await import(
    "../providers/arsenkin/prisma-provider-task-store"
  );
  const { ensureArsenkinTask } = await import("../providers/arsenkin/poll-worker");
  const client = createArsenkinClientFromEnv();
  if (!client) throw new ConflictError("SUBMIT_TRANSPORT_UNAVAILABLE");
  const store = createPrismaProviderTaskStore();
  const row = await ensureArsenkinTask(client, store, {
    caseId: input.caseId,
    reportRunId: input.enrichmentRunId,
    toolName: String(input.requestJson.tools_name),
    data: input.requestJson.data,
  });
  const externalTaskId = String(row.externalTaskId ?? "").trim();
  if (!externalTaskId) {
    throw new ConflictError(
      row.state === "SUBMIT_REJECTED_RETRYABLE"
        ? "SUBMIT_REJECTED_RETRYABLE"
        : "SUBMIT_DID_NOT_YIELD_EXTERNAL_TASK_ID"
    );
  }
  return { externalTaskId, providerTaskId: row.id };
}

async function defaultListProviderTasks(enrichmentRunId: string) {
  try {
    const { prisma } = await import("@/server/prisma/client");
    const rows = await prisma.providerTask.findMany({
      where: { reportRunId: enrichmentRunId },
      select: {
        id: true,
        state: true,
        toolName: true,
        externalTaskId: true,
        requestHash: true,
        responseJson: true,
        requestJson: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      state: String(r.state),
      toolName: r.toolName,
      externalTaskId: r.externalTaskId,
      requestHash: r.requestHash,
      responseJson: r.responseJson,
      requestJson: r.requestJson,
    }));
  } catch {
    return [];
  }
}

async function defaultLoadSubject(caseId: string) {
  try {
    const { prisma } = await import("@/server/prisma/client");
    const subject = await prisma.subject.findFirst({
      where: { caseId },
      select: { fullName: true, aliases: true },
    });
    return {
      fullName: subject?.fullName ?? null,
      aliases: Array.isArray(subject?.aliases)
        ? (subject!.aliases as unknown[]).map((a) => String(a))
        : [],
    };
  } catch {
    return { fullName: null, aliases: [] as string[] };
  }
}

/** Compute fingerprint for UI/API clients (offline-safe). */
export function computeSuggestionsRetryFingerprint(input: {
  enrichmentRunId: string;
  queriesRu: string[];
  queriesUae: string[];
}): { requestHash: string; taskFingerprint: string; requestJson: { tools_name: string; data: Record<string, unknown> } } {
  const built = tryBuildSuggestRequest({
    queries: input.queriesRu.length > 0 ? input.queriesRu : input.queriesUae,
    se: 1,
    region: ARSENKIN_REGION.YANDEX_MOSCOW,
    depth: 1,
  });
  if (!built.ok) {
    throw new Error(built.message);
  }
  const requestHash = hashProviderRequest(built.request);
  return {
    requestHash,
    requestJson: built.request,
    taskFingerprint: taskFingerprint({
      enrichmentRunId: input.enrichmentRunId,
      agentName: "ARSENKIN_SUGGESTIONS_REAL",
      requestHash,
    }),
  };
}
