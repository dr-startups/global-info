/**
 * Targeted paid retry for a single missing Arsenkin enrichment CaseAgent task
 * (typically SUGGESTIONS after SUBMIT_REJECTED_RETRYABLE / SUBMIT_UNKNOWN).
 * Never creates a new unified job / AgentRun / enrichmentRun / base collection.
 *
 * Live /set is gated by a one-shot LiveExecutionAuthorization installed only for
 * the confirmed SUGGESTIONS submit (same mechanism as full live audit).
 */

import { createHash, randomUUID } from "node:crypto";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors";
import { ARSENKIN_REGION } from "../providers/arsenkin/regions";
import {
  tryBuildSuggestRequest,
  type SuggestQuerySelection,
} from "../providers/arsenkin/adapters/suggest";
import { hashProviderRequest } from "../providers/arsenkin/provider-task-store";
import {
  buildLiveAuthorizationFromPlan,
  getActiveLiveAuthorization,
  withLiveAuthorization,
} from "../providers/arsenkin/live-execution-authorization";
import { buildArsenkinSubjectQueryPlan } from "../orion-golden/classic/arsenkin-subject-query-plan";
import { buildSubjectIdentityProfile } from "../orion-golden/identity/subject-identity-profile-builder";
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

export const SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION =
  "SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION" as const;

export type TargetedEnrichmentRetryAgent = "SUGGESTIONS" | "ARSENKIN_SUGGESTIONS_REAL";

export type TargetedProviderTaskRow = {
  id: string;
  state: string;
  toolName: string | null;
  externalTaskId: string | null;
  requestHash?: string | null;
  responseJson?: unknown;
  requestJson?: unknown;
  errorCode?: string | null;
};

export type TargetedEnrichmentRetryDeps = {
  /** Injected submit — tests fake; live wraps ensureArsenkinTask under one-shot auth. */
  submitSuggestTask?: (input: {
    caseId: string;
    enrichmentRunId: string;
    requestJson: { tools_name: string; data: Record<string, unknown> };
    requestHash: string;
  }) => Promise<{ externalTaskId: string; providerTaskId: string }>;
  /** Load subject identity for query plan (offline fixture). */
  loadSubject?: (caseId: string) => Promise<{ fullName: string | null; aliases: string[] }>;
  /** Existing ProviderTasks for the enrichment run (offline fixture). */
  listProviderTasks?: (enrichmentRunId: string) => Promise<TargetedProviderTaskRow[]>;
  /**
   * Re-queue a proven NO_EXTERNAL_REQUEST SUBMIT_UNKNOWN row to QUEUED so
   * ensureArsenkinTask may submit once without creating a duplicate row.
   */
  requeueNoExternalRequestTask?: (providerTaskId: string) => Promise<void>;
  /**
   * Reuse a SUBMIT_REJECTED_RETRYABLE suggest row with a corrected payload
   * (new requestHash). Never creates a second ProviderTask for the same retry.
   */
  supersedeRejectedSuggestTask?: (input: {
    providerTaskId: string;
    requestJson: { tools_name: string; data: Record<string, unknown> };
    requestHash: string;
    selection: SuggestQuerySelection;
    priorRequestHash: string | null;
  }) => Promise<void>;
  now?: () => Date;
  /** When false, caller drains ticks manually (tests). Default true. */
  autoSchedule?: boolean;
  /** Injectable scheduler (tests). Default: scheduleUnifiedTick. */
  scheduleTick?: (caseId: string) => void;
};

function schedulePostSubmitUnifiedTick(
  caseId: string,
  deps?: TargetedEnrichmentRetryDeps
): void {
  if (deps?.autoSchedule === false) return;
  if (deps?.scheduleTick) {
    deps.scheduleTick(caseId);
    return;
  }
  void import("./unified-orion-collection-orchestrator")
    .then(({ scheduleUnifiedTick }) => {
      scheduleUnifiedTick(caseId);
    })
    .catch(() => undefined);
}

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
  reusedNoExternalRequestTask: boolean;
  reusedRejectedSuggestTask: boolean;
  selection?: SuggestQuerySelection;
  stage: string;
  status: "WAITING";
  resumeCheckpoint: "ARSENKIN_RESULT_INGEST";
};

function suggestRequestSe(task: TargetedProviderTaskRow): number | null {
  const rj = task.requestJson;
  if (rj == null || typeof rj !== "object" || Array.isArray(rj)) return null;
  const data = (rj as { data?: unknown }).data;
  if (data == null || typeof data !== "object" || Array.isArray(data)) return null;
  const se = Number((data as { se?: unknown }).se);
  return Number.isFinite(se) ? se : null;
}

function findSupersedableRejectedSuggest(
  tasks: TargetedProviderTaskRow[],
  targetSe: number
): TargetedProviderTaskRow | null {
  const rejected = tasks.filter(
    (t) =>
      /suggest/i.test(String(t.toolName ?? "")) &&
      String(t.state).toUpperCase() === "SUBMIT_REJECTED_RETRYABLE" &&
      !String(t.externalTaskId ?? "").trim()
  );
  if (rejected.length === 0) return null;
  const seMatch = rejected.find((t) => suggestRequestSe(t) === targetSe);
  if (seMatch) return seMatch;
  // Legacy fixture without se: only when it is the sole rejected suggest row.
  if (rejected.length === 1 && suggestRequestSe(rejected[0]!) == null) {
    return rejected[0]!;
  }
  return null;
}

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

function submitDiagnosticsOf(responseJson: unknown): Record<string, unknown> | null {
  if (responseJson == null || typeof responseJson !== "object") return null;
  const d = (responseJson as { _submitDiagnostics?: unknown })._submitDiagnostics;
  if (d == null || typeof d !== "object" || Array.isArray(d)) return null;
  return d as Record<string, unknown>;
}

/**
 * Proven pre-network failure: SUBMIT_UNKNOWN caused by live-auth gate with no
 * Arsenkin HTTP (httpStatus=null). Safe to re-queue for one targeted submit.
 */
export function isProvenNoExternalRequestSubmitUnknown(
  task: Pick<TargetedProviderTaskRow, "state" | "externalTaskId" | "responseJson" | "errorCode">
): boolean {
  if (Boolean(String(task.externalTaskId ?? "").trim())) return false;
  if (String(task.state).toUpperCase() !== "SUBMIT_UNKNOWN") return false;
  const diag = submitDiagnosticsOf(task.responseJson);
  if (!diag) {
    // Fall back to errorCode + message patterns when diagnostics were not persisted.
    return /no-live-authorization/i.test(String(task.errorCode ?? ""));
  }
  if (diag.httpStatus != null) return false;
  const message = String(diag.message ?? "");
  return /arsenkin-live-set-blocked:no-live-authorization/i.test(message);
}

/** Ambiguous SUBMIT_UNKNOWN after a real/uncertain network outcome — no auto re-submit. */
export function isAmbiguousSubmitUnknown(
  task: Pick<TargetedProviderTaskRow, "state" | "externalTaskId" | "responseJson" | "errorCode">
): boolean {
  if (Boolean(String(task.externalTaskId ?? "").trim())) return false;
  if (String(task.state).toUpperCase() !== "SUBMIT_UNKNOWN") return false;
  return !isProvenNoExternalRequestSubmitUnknown(task);
}

function findSuggestionsEnrichmentRunId(job: UnifiedCollectionJob): string | null {
  const ids = job.enrichmentRunIds ?? [];
  const hit = ids.find((id) => /suggestions/i.test(id));
  return hit ?? null;
}

export function buildTargetedSuggestionsLiveAuthorization(input: {
  enrichmentRunId: string;
  requestHash: string;
}): ReturnType<typeof buildLiveAuthorizationFromPlan> {
  return buildLiveAuthorizationFromPlan({
    reportRunId: input.enrichmentRunId,
    planDigest: `targeted-suggestions-retry:${input.requestHash}`,
    requestHashes: [input.requestHash],
    maxNewTasks: 1,
    maxEstimatedLimits: 1,
    stage: "TARGETED_SUGGESTIONS_RETRY",
  });
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

  // Pre-lease: detect reusable accepted task / require confirmation for paid submit.
  const tasksPreview =
    (await input.deps?.listProviderTasks?.(enrichmentRunId)) ??
    (await defaultListProviderTasks(enrichmentRunId));
  const suggestPreview = tasksPreview.filter((t) => /suggest/i.test(String(t.toolName ?? "")));
  const reusablePreview = suggestPreview.find(
    (t) =>
      Boolean(t.externalTaskId) ||
      String(t.state).toUpperCase() === "DONE" ||
      isIngestibleResponse(t.responseJson)
  );

  if (!reusablePreview?.externalTaskId && !input.confirmPaidEnrichmentRetry) {
    throw new ConflictError(PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED);
  }

  // Pre-lease: fail-closed query selection before lease / live-auth / HTTP.
  // When an accepted externalTaskId already exists we skip rebuild (reuse path).
  let prepared:
    | {
        requestJson: { tools_name: string; data: Record<string, unknown> };
        selection: SuggestQuerySelection;
        requestHash: string;
      }
    | null = null;
  if (!reusablePreview?.externalTaskId) {
    const subject =
      (await input.deps?.loadSubject?.(input.caseId)) ??
      (await defaultLoadSubject(input.caseId));
    const qp = buildArsenkinSubjectQueryPlan({
      fullName: subject.fullName,
      aliases: subject.aliases,
    });
    const identity = buildSubjectIdentityProfile({
      caseId: input.caseId,
      subjectName: subject.fullName || qp.fullName || subject.aliases[0] || "",
      aliases: subject.aliases,
    });
    const candidates =
      identity.queryVariants.length > 0
        ? identity.queryVariants
        : qp.queriesRu.length > 0
          ? qp.queriesRu
          : qp.queriesUae;
    const primaryLocalized =
      qp.primaryIdentityRu ??
      (identity.displayName && /[\u0400-\u04FF]/.test(identity.displayName)
        ? identity.displayName
        : null);
    const primaryLatin = qp.primaryIdentityUae ?? identity.transliterations[0] ?? null;

    const built = tryBuildSuggestRequest({
      queries: candidates,
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      depth: 1,
      primaryLocalized,
      primaryLatin,
    });
    if (!built.ok) {
      const code =
        built.code === "SUGGEST_QUERY_UNAVAILABLE"
          ? "SUGGEST_QUERY_UNAVAILABLE"
          : "SUGGEST_REQUEST_INVALID";
      throw new ConflictError(`${code}:${built.message}`);
    }
    prepared = {
      requestJson: built.request,
      selection: built.selection,
      requestHash: hashProviderRequest(built.request),
    };
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
        nextPollAt: (input.deps?.now ?? (() => new Date()))().toISOString(),
        pollAttempt: 0,
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        warnings: [
          ...job.warnings.filter((w) => !/^targeted-retry:/i.test(w)),
          "targeted-retry:reused-existing-suggestions-task",
        ],
      });
      schedulePostSubmitUnifiedTick(input.caseId, input.deps);
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
        reusedNoExternalRequestTask: false,
        reusedRejectedSuggestTask: false,
        stage: "ARSENKIN_ENRICHMENT",
        status: "WAITING",
        resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      };
    }

    // Defense-in-depth (also checked pre-lease).
    if (!input.confirmPaidEnrichmentRetry) {
      throw new ConflictError(PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED);
    }
    if (!prepared) {
      throw new ConflictError("SUGGEST_REQUEST_INVALID:prepared payload missing");
    }
    const requestJson = prepared.requestJson;
    const selection = prepared.selection;
    const requestHash = prepared.requestHash;
    const targetSe = Number(requestJson.data.se) === 1 ? 1 : Number(requestJson.data.se);
    const fingerprint = taskFingerprint({ enrichmentRunId, agentName, requestHash });
    if (
      input.expectedTaskFingerprint &&
      String(input.expectedTaskFingerprint).trim() &&
      String(input.expectedTaskFingerprint).trim() !== fingerprint
    ) {
      throw new ConflictError("TASK_FINGERPRINT_MISMATCH");
    }

    const sameHash = suggestTasks.find(
      (t) => String(t.requestHash ?? "") === requestHash && !String(t.externalTaskId ?? "").trim()
    );
    let reusedNoExternalRequestTask = false;
    let reusedRejectedSuggestTask = false;
    if (sameHash) {
      if (isAmbiguousSubmitUnknown(sameHash)) {
        throw new ConflictError(SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION);
      }
      if (isProvenNoExternalRequestSubmitUnknown(sameHash)) {
        const requeue =
          input.deps?.requeueNoExternalRequestTask ?? defaultRequeueNoExternalRequestTask;
        await requeue(sameHash.id);
        reusedNoExternalRequestTask = true;
      } else if (String(sameHash.state).toUpperCase() === "SUBMIT_REJECTED_RETRYABLE") {
        const supersede =
          input.deps?.supersedeRejectedSuggestTask ?? defaultSupersedeRejectedSuggestTask;
        await supersede({
          providerTaskId: sameHash.id,
          requestJson,
          requestHash,
          selection,
          priorRequestHash: String(sameHash.requestHash ?? "") || null,
        });
        sameHash.state = "QUEUED";
        sameHash.requestHash = requestHash;
        sameHash.requestJson = requestJson;
        reusedRejectedSuggestTask = true;
      }
    } else {
      // Payload changed (e.g. 4 queries → 1): reuse the rejected row with new hash.
      const rejected = findSupersedableRejectedSuggest(suggestTasks, targetSe);
      if (rejected) {
        const supersede =
          input.deps?.supersedeRejectedSuggestTask ?? defaultSupersedeRejectedSuggestTask;
        await supersede({
          providerTaskId: rejected.id,
          requestJson,
          requestHash,
          selection,
          priorRequestHash: String(rejected.requestHash ?? "") || null,
        });
        rejected.state = "QUEUED";
        rejected.requestHash = requestHash;
        rejected.requestJson = requestJson;
        reusedRejectedSuggestTask = true;
      }
    }

    const submitInner =
      input.deps?.submitSuggestTask ??
      (async (args) => {
        // Offline / NETWORK_CALLS=0 must never open Arsenkin transport.
        if (process.env.NETWORK_CALLS === "0") {
          throw new ConflictError("SUBMIT_TRANSPORT_UNAVAILABLE");
        }
        return defaultSubmitSuggestTask(args);
      });

    const authorization = buildTargetedSuggestionsLiveAuthorization({
      enrichmentRunId,
      requestHash,
    });

    const submitted = await withLiveAuthorization(authorization, async () => {
      if (!getActiveLiveAuthorization()) {
        throw new ConflictError("LIVE_AUTHORIZATION_NOT_INSTALLED");
      }
      return submitInner({
        caseId: input.caseId,
        enrichmentRunId,
        requestJson,
        requestHash,
      });
    });

    // One-shot auth must not leak past the submit.
    if (getActiveLiveAuthorization()) {
      throw new ConflictError("LIVE_AUTHORIZATION_LEAK");
    }

    const externalTaskId = String(submitted.externalTaskId ?? "").trim();
    if (!externalTaskId) {
      throw new ConflictError("SUBMIT_DID_NOT_YIELD_EXTERNAL_TASK_ID");
    }

    writeUnifiedArtifact(input.caseId, job.unifiedJobId, "enrichment-targeted-retry-audit.json", {
      version: "enrichment-targeted-retry-audit-v1",
      at: (input.deps?.now ?? (() => new Date()))().toISOString(),
      actorId: input.actorId,
      jobId,
      enrichmentRunId,
      agentName,
      reusedExisting: false,
      reusedNoExternalRequestTask,
      reusedRejectedSuggestTask,
      externalTaskId,
      providerTaskId: submitted.providerTaskId,
      requestHash,
      taskFingerprint: fingerprint,
      submissions: 1,
      confirmPaidEnrichmentRetry: true,
      oneShotLiveAuth: true,
      selection: {
        selectedQuery: selection.selectedQuery,
        selectedQueryHash: selection.selectedQueryHash,
        selectionReason: selection.selectionReason,
        candidateQueryCount: selection.candidateQueryCount,
        rejectedCandidateHashes: selection.rejectedCandidateHashes,
      },
      queryCount: Array.isArray(requestJson.data.queries) ? requestJson.data.queries.length : 0,
    });

    patchUnifiedCollectionJob(input.caseId, {
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      nextPollAt: (input.deps?.now ?? (() => new Date()))().toISOString(),
      pollAttempt: 0,
      lastError: null,
      lastErrorCode: null,
      completedAt: null,
      arsenkinEnrichmentState: job.arsenkinEnrichmentState
        ? { ...job.arsenkinEnrichmentState, enrichmentComplete: false }
        : job.arsenkinEnrichmentState,
      warnings: [
        ...job.warnings.filter((w) => !/^targeted-retry:/i.test(w)),
        "targeted-retry:suggestions-submitted:1",
        `targeted-retry:externalTaskId:${externalTaskId}`,
        `targeted-retry:queries:1`,
        reusedNoExternalRequestTask
          ? "targeted-retry:reused-no-external-request-task"
          : reusedRejectedSuggestTask
            ? "targeted-retry:reused-rejected-suggest-task"
            : "targeted-retry:new-or-fresh-queued-task",
      ],
    });

    // Durable continuation: poll existing externalTaskId → ingest → composite…
    schedulePostSubmitUnifiedTick(input.caseId, input.deps);

    return {
      accepted: true,
      jobId: job.jobId,
      unifiedJobId: job.unifiedJobId,
      enrichmentRunId,
      agentName,
      externalTaskId,
      providerTaskId: submitted.providerTaskId,
      requestHash,
      submissions: 1,
      reusedExisting: false,
      reusedNoExternalRequestTask,
      reusedRejectedSuggestTask,
      selection,
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
  // Caller must install one-shot LiveExecutionAuthorization.
  if (!getActiveLiveAuthorization()) {
    throw new ConflictError("LIVE_AUTHORIZATION_NOT_INSTALLED");
  }
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
    if (row.state === "SUBMIT_REJECTED_RETRYABLE") {
      throw new ConflictError("SUBMIT_REJECTED_RETRYABLE");
    }
    if (row.state === "SUBMIT_UNKNOWN") {
      // Real/uncertain network outcome — never auto-loop.
      throw new ConflictError(SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION);
    }
    throw new ConflictError("SUBMIT_DID_NOT_YIELD_EXTERNAL_TASK_ID");
  }
  return { externalTaskId, providerTaskId: row.id };
}

async function defaultRequeueNoExternalRequestTask(providerTaskId: string): Promise<void> {
  const { createPrismaProviderTaskStore } = await import(
    "../providers/arsenkin/prisma-provider-task-store"
  );
  const store = createPrismaProviderTaskStore();
  await store.updateState(
    providerTaskId,
    {
      state: "QUEUED",
      errorCode: null,
      responseJson: {
        _targetedRetryRequeue: {
          reason: "NO_EXTERNAL_REQUEST",
          prior: "arsenkin-live-set-blocked:no-live-authorization",
          at: new Date().toISOString(),
        },
      },
      nextPollAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      leaseUntil: null,
      completedAt: null,
      submittedAt: null,
    },
    { expectStates: ["SUBMIT_UNKNOWN"] }
  );
}

async function defaultSupersedeRejectedSuggestTask(input: {
  providerTaskId: string;
  requestJson: { tools_name: string; data: Record<string, unknown> };
  requestHash: string;
  selection: SuggestQuerySelection;
  priorRequestHash: string | null;
}): Promise<void> {
  const { prisma } = await import("@/server/prisma/client");
  const current = await prisma.providerTask.findUnique({
    where: { id: input.providerTaskId },
    select: { reportRunId: true, requestHash: true, state: true, externalTaskId: true },
  });
  if (
    !current ||
    !current.reportRunId ||
    String(current.state) !== "SUBMIT_REJECTED_RETRYABLE" ||
    current.externalTaskId
  ) {
    throw new ConflictError("SUPERSEDE_REJECTED_SUGGEST_FAILED");
  }
  if (current.requestHash !== input.requestHash) {
    const collision = await prisma.providerTask.findUnique({
      where: {
        reportRunId_provider_requestHash: {
          reportRunId: current.reportRunId,
          provider: "arsenkin",
          requestHash: input.requestHash,
        },
      },
      select: { id: true },
    });
    if (collision && collision.id !== input.providerTaskId) {
      throw new ConflictError("REQUEST_HASH_COLLISION");
    }
  }
  const result = await prisma.providerTask.updateMany({
    where: {
      id: input.providerTaskId,
      state: "SUBMIT_REJECTED_RETRYABLE",
      externalTaskId: null,
    },
    data: {
      requestHash: input.requestHash,
      requestJson: input.requestJson as object,
      state: "QUEUED",
      errorCode: null,
      attempts: 0,
      responseJson: {
        _targetedRetrySupersede: {
          reason: "PAYLOAD_FIXED_EXACTLY_ONE_QUERY",
          priorRequestHash: input.priorRequestHash,
          selectedQuery: input.selection.selectedQuery,
          selectedQueryHash: input.selection.selectedQueryHash,
          selectionReason: input.selection.selectionReason,
          candidateQueryCount: input.selection.candidateQueryCount,
          rejectedCandidateHashes: input.selection.rejectedCandidateHashes,
          at: new Date().toISOString(),
        },
      },
      nextPollAt: new Date(),
      lockedBy: null,
      lockedAt: null,
      leaseUntil: null,
      completedAt: null,
      submittedAt: null,
    },
  });
  if (!result.count) {
    throw new ConflictError("SUPERSEDE_REJECTED_SUGGEST_FAILED");
  }
}

async function defaultListProviderTasks(enrichmentRunId: string): Promise<TargetedProviderTaskRow[]> {
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
        errorCode: true,
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
      errorCode: r.errorCode,
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
  primaryLocalized?: string | null;
  primaryLatin?: string | null;
  /** Optional full candidate set (e.g. SubjectIdentityProfile.queryVariants). */
  candidates?: string[];
}): {
  requestHash: string;
  taskFingerprint: string;
  requestJson: { tools_name: string; data: Record<string, unknown> };
  selection: SuggestQuerySelection;
} {
  const candidates =
    input.candidates && input.candidates.length > 0
      ? input.candidates
      : input.queriesRu.length > 0
        ? input.queriesRu
        : input.queriesUae;
  const built = tryBuildSuggestRequest({
    queries: candidates,
    se: 1,
    region: ARSENKIN_REGION.YANDEX_MOSCOW,
    depth: 1,
    primaryLocalized: input.primaryLocalized ?? input.queriesRu[0] ?? null,
    primaryLatin: input.primaryLatin ?? input.queriesUae[0] ?? null,
  });
  if (!built.ok) {
    throw new Error(`${built.code}:${built.message}`);
  }
  const requestHash = hashProviderRequest(built.request);
  return {
    requestHash,
    requestJson: built.request,
    selection: built.selection,
    taskFingerprint: taskFingerprint({
      enrichmentRunId: input.enrichmentRunId,
      agentName: "ARSENKIN_SUGGESTIONS_REAL",
      requestHash,
    }),
  };
}
