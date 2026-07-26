/**
 * Staff recovery for a failed unified ORION collection job.
 * Rebinds baseReportRunId from an existing base-collection-manifest and
 * resumes at ARSENKIN_ENRICHMENT — never re-runs Yandex/Google/Serper/Wikipedia.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors";
import { ensurePersistedUnifiedBaseReportRun } from "./unified-base-report-run";
import {
  claimUnifiedJobLease,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  readUnifiedArtifact,
  releaseUnifiedJobLease,
  unifiedArtifactsDir,
  writeUnifiedArtifact,
} from "./unified-collection-job-store";
import type {
  BaseCollectionManifest,
  ReportDataBinding,
  UnifiedCollectionJob,
  UnifiedCollectionStage,
} from "./unified-collection-types";
import { loadReusableAssembledDeck } from "./canonical-report-prepare";
import {
  planResumeFromSteps,
  type StepResumePlan,
} from "../workflow/resume-plan";

export type UnifiedRecoveryAudit = {
  recoveredFromStatus: string;
  recoveredFromStage: UnifiedCollectionStage | string;
  recoveryRequestedAt: string;
  recoveryRequestedBy: string;
  recoveryReason: string;
  previousLastError: string | null;
  previousLastErrorCode: string | null;
};

/**
 * Grace beyond the scheduled poll before a waiting job counts as stalled.
 * The durable poll backoff caps at 30s, so two minutes of silence is well
 * outside normal operation.
 */
export const POLL_STALL_GRACE_MS = 120_000;

/**
 * True when the next scheduled tick is overdue (or was never scheduled), i.e.
 * nothing is going to move without help.
 */
export function isPollOverdue(
  job: { nextPollAt?: string | null; updatedAt?: string | null },
  now: Date
): boolean {
  const raw = job.nextPollAt ?? job.updatedAt ?? null;
  if (!raw) return true;
  const due = Date.parse(raw);
  if (Number.isNaN(due)) return true;
  return now.getTime() - due > POLL_STALL_GRACE_MS;
}

export type UnifiedRecoveryEligibility = {
  recoveryAllowed: boolean;
  recoveryBlockerReason: string | null;
  recoveryReason: string | null;
};

const ACTIVE_STAGES = new Set<UnifiedCollectionStage>([
  "BASE_COLLECTION",
  "ARSENKIN_ENRICHMENT",
  "COMPOSITE_MERGE",
  "ORION_PREPARE",
  "CLIENT_CONTENT",
]);

function leaseIsActive(job: UnifiedCollectionJob, now: Date): boolean {
  if (!job.leaseOwnerId || !job.leaseUntil) return false;
  const until = Date.parse(job.leaseUntil);
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * План возобновления по шагам, если конвейер у прогона есть.
 *
 * `null` означает «шагов нет» — прогон создан до шага 12, и отвечать на вопрос
 * будет прежняя эвристика. Недоступность таблицы тоже даёт `null`: потерять
 * возможность восстановления из-за сбоя чтения хуже, чем ответить по-старому.
 */
async function resumePlanFromSteps(
  job: UnifiedCollectionJob,
  now: Date
): Promise<StepResumePlan | null> {
  try {
    const { listPipelineSteps } = await import("../workflow/step-store");
    const steps = await listPipelineSteps(job.unifiedJobId);
    if (steps.length === 0) return null;
    return planResumeFromSteps(steps, now);
  } catch {
    return null;
  }
}

function manifestHasBaseObservations(manifest: BaseCollectionManifest | null | undefined): boolean {
  if (!manifest) return false;
  if (manifest.caseId && manifest.unifiedJobId) {
    /* lineage fields present */
  } else {
    return false;
  }
  const idCount =
    (manifest.searchResultIds?.length ?? 0) +
    (manifest.searchSurfaceItemIds?.length ?? 0) +
    (manifest.caseCorpusSearchResultIds?.length ?? 0) +
    (manifest.caseCorpusSurfaceItemIds?.length ?? 0);
  return (manifest.baseCount ?? 0) > 0 || idCount > 0;
}

function hasHistoricalNoBaseReportDefect(job: UnifiedCollectionJob): boolean {
  const blob = [...(job.warnings ?? []), job.lastErrorCode ?? "", job.lastError ?? ""].join("\n");
  return (
    /arsenkin-skipped:no-baseReportRunId/i.test(blob) ||
    /arsenkin-blocked:no-baseReportRunId/i.test(blob) ||
    /BASE_REPORT_RUN_MISSING/i.test(blob)
  );
}

/**
 * Pure eligibility. Does not mutate storage. Server is the source of truth —
 * never trust a client recoveryAllowed flag.
 */
export async function evaluateUnifiedCollectionRecoveryEligibility(input: {
  caseId: string;
  job: UnifiedCollectionJob | null;
  /** When set, must match the loaded job's jobId/unifiedJobId. */
  requestedJobId?: string | null;
  manifest?: BaseCollectionManifest | null;
  now?: Date;
  /** When set, an active lease owned by this id is ignored (caller holds it). */
  leaseOwnerId?: string | null;
  /** Skip lease gate entirely (internal re-check after claim). */
  ignoreLease?: boolean;
}): Promise<UnifiedRecoveryEligibility> {
  const now = input.now ?? new Date();
  const job = input.job;
  if (!job) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_NOT_FOUND",
      recoveryReason: null,
    };
  }
  if (job.caseId !== input.caseId) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "FOREIGN_CASE",
      recoveryReason: null,
    };
  }
  const requested = String(input.requestedJobId ?? "").trim();
  if (requested && requested !== job.jobId && requested !== job.unifiedJobId) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_ID_MISMATCH",
      recoveryReason: null,
    };
  }
  if (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL" || job.status === "COMPLETED") {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_ALREADY_COMPLETED",
      recoveryReason: null,
    };
  }
  if (job.stage === "CANCELLED" || job.status === "CANCELLED") {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_CANCELLED",
      recoveryReason: null,
    };
  }
  if (!input.ignoreLease && leaseIsActive(job, now)) {
    const ownLease =
      input.leaseOwnerId && job.leaseOwnerId && job.leaseOwnerId === input.leaseOwnerId;
    if (!ownLease) {
      return {
        recoveryAllowed: false,
        recoveryBlockerReason: "ACTIVE_LEASE",
        recoveryReason: null,
      };
    }
  }
  if (ACTIVE_STAGES.has(job.stage) && job.status === "RUNNING") {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_ALREADY_RUNNING",
      recoveryReason: null,
    };
  }
  // WAITING with a poll still due is the normal state of durable Arsenkin
  // ingest, not a stall: the backoff caps at 30s, so a tick that is not yet
  // overdue means the job is working. Offering "Продолжить импорт Arsenkin"
  // then invites the operator to intervene in a healthy run — the same class of
  // problem as the false Suggestions retry (step 11.1-bis).
  if (ACTIVE_STAGES.has(job.stage) && job.status === "WAITING" && !isPollOverdue(job, now)) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_PROGRESSING",
      recoveryReason: null,
    };
  }

  // Шаг 12.4: «где мы остановились» спрашивается у шагов, а не выводится
  // эвристиками из шести полей джобы. Прежний вывод оставлен ниже для
  // прогонов, созданных до появления конвейера шагов.
  const stepPlan = await resumePlanFromSteps(job, now);
  if (stepPlan) {
    switch (stepPlan.kind) {
      case "completed":
        return {
          recoveryAllowed: false,
          recoveryBlockerReason: "JOB_ALREADY_COMPLETED",
          recoveryReason: null,
        };
      case "in_progress":
        return {
          recoveryAllowed: false,
          recoveryBlockerReason: "JOB_PROGRESSING",
          recoveryReason: null,
        };
      case "exhausted":
        return {
          recoveryAllowed: false,
          recoveryBlockerReason: "STEP_ATTEMPTS_EXHAUSTED",
          recoveryReason: null,
        };
      case "resume":
        return {
          recoveryAllowed: true,
          recoveryBlockerReason: null,
          recoveryReason: stepPlan.reason,
        };
    }
  }

  const manifest =
    input.manifest !== undefined
      ? input.manifest
      : await readUnifiedArtifact<BaseCollectionManifest>(
          job.caseId,
          job.unifiedJobId,
          "base-collection-manifest.json"
        );

  if (!manifest) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "BASE_MANIFEST_MISSING",
      recoveryReason: null,
    };
  }
  if (manifest.caseId !== job.caseId || manifest.unifiedJobId !== job.unifiedJobId) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "MANIFEST_LINEAGE_MISMATCH",
      recoveryReason: null,
    };
  }
  if (!manifestHasBaseObservations(manifest)) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "BASE_MANIFEST_EMPTY_OR_CORRUPT",
      recoveryReason: null,
    };
  }

  // Idempotent in-flight recovery checkpoint (same job, already rebound).
  if (
    (job.stage === "ARSENKIN_ENRICHMENT" || job.stage === "ORION_PREPARE") &&
    (job.status === "WAITING" || job.status === "RUNNING") &&
    Boolean(job.baseReportRunId) &&
    Boolean(job.recoveryAudit)
  ) {
    return {
      recoveryAllowed: true,
      recoveryBlockerReason: null,
      recoveryReason:
        job.resumeCheckpoint === "RENDER" || job.stage === "ORION_PREPARE"
          ? "IDEMPOTENT_RENDER_RESUME"
          : "IDEMPOTENT_RESUME",
    };
  }

  const enrichmentCount = job.enrichmentRunIds?.length ?? 0;
  const enrichmentComplete = Boolean(job.arsenkinEnrichmentState?.enrichmentComplete);
  const isRenderFailure =
    job.resumeCheckpoint === "RENDER" ||
    job.lastErrorCode === "RENDER_FAILED" ||
    /render failed/i.test(job.lastError ?? "");
  // Ingest resume must not steal RENDER_FAILED jobs (isRenderFailure).
  // Job B pattern: FAILED_TERMINAL + composite present + enrichment never ingested.
  const needsArsenkinIngest =
    !isRenderFailure &&
    (job.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" ||
      (enrichmentCount >= 5 && !enrichmentComplete && Boolean(job.baseReportRunId)));

  // Waiting for Arsenkin ingest (durable poll) — recoverable / idempotent.
  if (
    job.stage === "ARSENKIN_ENRICHMENT" &&
    (job.status === "WAITING" || job.status === "RUNNING") &&
    (job.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" ||
      (enrichmentCount >= 5 && !enrichmentComplete))
  ) {
    return {
      recoveryAllowed: true,
      recoveryBlockerReason: null,
      recoveryReason: "ARSENKIN_INGEST_RESUME",
    };
  }

  if (job.stage === "FAILED_RETRYABLE" && isRenderFailure) {
    if (!job.baseReportRunId || enrichmentCount < 5 || !job.compositeDatasetId) {
      return {
        recoveryAllowed: false,
        recoveryBlockerReason: "RENDER_RESUME_PRECONDITIONS_MISSING",
        recoveryReason: null,
      };
    }
    return {
      recoveryAllowed: true,
      recoveryBlockerReason: null,
      recoveryReason: "RENDER_RESUME",
    };
  }

  if (job.stage === "FAILED_RETRYABLE" && needsArsenkinIngest) {
    return {
      recoveryAllowed: true,
      recoveryBlockerReason: null,
      recoveryReason: "ARSENKIN_INGEST_RESUME",
    };
  }

  if (job.stage === "FAILED_RETRYABLE") {
    return {
      recoveryAllowed: true,
      recoveryBlockerReason: null,
      recoveryReason: "FAILED_RETRYABLE_RESUME",
    };
  }

  if (job.stage === "FAILED_TERMINAL") {
    const missingBaseId = !String(job.baseReportRunId ?? "").trim();
    const historical = hasHistoricalNoBaseReportDefect(job);
    if (missingBaseId && historical) {
      return {
        recoveryAllowed: true,
        recoveryBlockerReason: null,
        recoveryReason: "HISTORICAL_NO_BASE_REPORT_RUN",
      };
    }
    // Job B pattern: terminal after gate/render but Arsenkin never ingested.
    if (needsArsenkinIngest && manifestHasBaseObservations(manifest)) {
      return {
        recoveryAllowed: true,
        recoveryBlockerReason: null,
        recoveryReason: "ARSENKIN_INGEST_RESUME",
      };
    }
    // Section/assembly QA failure with intact composite — retry prepare only.
    const isAssemblyFailure =
      job.lastErrorCode === "ASSEMBLY_FAILED" ||
      job.lastErrorCode === "REQUIRED_SECTION_FAILED" ||
      /required sections failed|ASSEMBLY_FAILED/i.test(job.lastError ?? "");
    if (
      isAssemblyFailure &&
      Boolean(job.compositeDatasetId) &&
      Boolean(job.baseReportRunId) &&
      manifestHasBaseObservations(manifest)
    ) {
      return {
        recoveryAllowed: true,
        recoveryBlockerReason: null,
        recoveryReason: "ASSEMBLY_RESUME",
      };
    }
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "FAILED_TERMINAL_NOT_RECOVERABLE",
      recoveryReason: null,
    };
  }

  return {
    recoveryAllowed: false,
    recoveryBlockerReason: `STAGE_NOT_RECOVERABLE:${job.stage}`,
    recoveryReason: null,
  };
}

export type RecoverUnifiedCollectionResult = {
  accepted: true;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
  baseReportRunId: string;
  recoveryReason: string;
  createdBaseReportRun: boolean;
  idempotent: boolean;
};

export type RecoverUnifiedCollectionDeps = {
  prisma?: PrismaClient | null;
  /** Override persist helper (offline fake prisma). */
  ensureBaseReportRun?: typeof ensurePersistedUnifiedBaseReportRun;
  /** When true, skip real prisma and allow fixture-scoped base id. */
  fixtureBaseRows?: unknown[] | null;
  /** Forwarded to scheduleUnifiedTick after recovery. */
  autoSchedule?: boolean;
  runFullAudit?: never;
  runArsenkinEnrichment?: (job: UnifiedCollectionJob) => Promise<unknown>;
  runPrepare?: (input: unknown) => Promise<unknown>;
  subjectProfile?: unknown;
  renderDeck?: unknown;
  allowMockReport?: boolean;
  now?: () => Date;
  /** Offline/tests: sibling remap task loaders for ingest resume. */
  siblingRemap?: import("./unified-enrichment-sibling-remap").SiblingRemapDeps;
};

async function scheduleRecoverTick(
  caseId: string,
  deps: RecoverUnifiedCollectionDeps | undefined
): Promise<void> {
  if (deps?.autoSchedule === false) return;
  const { scheduleUnifiedTick } = await import("./unified-orion-collection-orchestrator");
  scheduleUnifiedTick(caseId, deps as Parameters<typeof scheduleUnifiedTick>[1]);
}

/**
 * Возвращает остановившийся шаг в очередь, чтобы его подобрал воркер.
 *
 * Без этого восстановление чинило бы джобу, о которой исполнитель не узнает:
 * упавший шаг сам себя не разбудит, а расписание живёт в его строке.
 */
async function requeueResumeStep(job: UnifiedCollectionJob, now: Date): Promise<string | null> {
  try {
    const { listPipelineSteps, requeueStep } = await import("../workflow/step-store");
    const steps = await listPipelineSteps(job.unifiedJobId);
    if (steps.length === 0) return null;
    const plan = planResumeFromSteps(steps, now);
    if (plan.kind !== "resume" || !plan.requeue) return null;
    const ok = await requeueStep({ jobId: job.unifiedJobId, name: plan.stepName, now });
    return ok ? plan.stepName : null;
  } catch {
    // Пробуждение — вспомогательное действие: его сбой не должен отменять
    // восстановление, которое уже поправило состояние джобы.
    return null;
  }
}

/**
 * Atomically recover the same jobId: persist base OrionReportRun from the
 * existing manifest, checkpoint at ARSENKIN_ENRICHMENT, schedule tick.
 * Never calls runFullAudit / base providers.
 */
export async function recoverUnifiedOrionCollectionJob(input: {
  caseId: string;
  jobId: string;
  actorId: string;
  deps?: RecoverUnifiedCollectionDeps;
}): Promise<RecoverUnifiedCollectionResult> {
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");

  const nowFn = input.deps?.now ?? (() => new Date());
  const job0 = await loadUnifiedCollectionJob(input.caseId);
  if (!job0) throw new NotFoundError("unified collection job not found");
  if (job0.jobId !== jobId && job0.unifiedJobId !== jobId) {
    throw new NotFoundError("jobId does not belong to this case");
  }

  const manifest0 = await readUnifiedArtifact<BaseCollectionManifest>(
    job0.caseId,
    job0.unifiedJobId,
    "base-collection-manifest.json"
  );
  const elig = await evaluateUnifiedCollectionRecoveryEligibility({
    caseId: input.caseId,
    job: job0,
    requestedJobId: jobId,
    manifest: manifest0,
    now: nowFn(),
  });
  if (!elig.recoveryAllowed) {
    // Повторное восстановление уже возобновлённой джобы — не ошибка, а
    // отсутствие работы: запрошенное состояние уже достигнуто. Гейт
    // JOB_PROGRESSING нужен, чтобы не предлагать кнопку на здоровом прогоне
    // (шаг 11.1-bis), но отвечать на повторный запрос 409 CONFLICT значит
    // показывать клиенту ошибку там, где всё в порядке.
    if (elig.recoveryBlockerReason === "JOB_PROGRESSING" && job0.baseReportRunId) {
      return {
        accepted: true,
        jobId: job0.jobId,
        unifiedJobId: job0.unifiedJobId,
        stage: job0.stage,
        status: job0.status,
        baseReportRunId: job0.baseReportRunId,
        recoveryReason: "ALREADY_PROGRESSING",
        createdBaseReportRun: false,
        idempotent: true,
      };
    }
    throw new ConflictError(elig.recoveryBlockerReason ?? "recovery not allowed");
  }

  // Idempotent: already rebound / already at render or arsenkin checkpoint.
  if (
    elig.recoveryReason === "IDEMPOTENT_RESUME" ||
    elig.recoveryReason === "IDEMPOTENT_RENDER_RESUME" ||
    (job0.baseReportRunId &&
      (job0.enrichmentRunIds?.length ?? 0) >= 5 &&
      ACTIVE_STAGES.has(job0.stage))
  ) {
    await requeueResumeStep(job0, nowFn());
    await scheduleRecoverTick(input.caseId, input.deps);
    return {
      accepted: true,
      jobId: job0.jobId,
      unifiedJobId: job0.unifiedJobId,
      stage: job0.stage,
      status: job0.status,
      baseReportRunId: String(job0.baseReportRunId),
      recoveryReason: elig.recoveryReason ?? "IDEMPOTENT_RESUME",
      createdBaseReportRun: false,
      idempotent: true,
    };
  }

  const ownerId = `unified-recover-${process.pid}-${randomUUID().slice(0, 6)}`;
  const claimed = await claimUnifiedJobLease({
    caseId: input.caseId,
    ownerId,
    leaseMs: 120_000,
    now: nowFn(),
  });
  if (!claimed) {
    throw new ConflictError("ACTIVE_LEASE");
  }

  try {
    // Re-check after lease (fail-closed race).
    const job = await loadUnifiedCollectionJob(input.caseId);
    if (!job || (job.jobId !== jobId && job.unifiedJobId !== jobId)) {
      throw new NotFoundError("unified collection job not found");
    }
    const manifest = await readUnifiedArtifact<BaseCollectionManifest>(
      job.caseId,
      job.unifiedJobId,
      "base-collection-manifest.json"
    );
    const elig2 = await evaluateUnifiedCollectionRecoveryEligibility({
      caseId: input.caseId,
      job,
      requestedJobId: jobId,
      manifest,
      now: nowFn(),
      leaseOwnerId: ownerId,
      ignoreLease: true,
    });
    if (!elig2.recoveryAllowed || !manifest) {
      throw new ConflictError(elig2.recoveryBlockerReason ?? "recovery not allowed");
    }

    let prisma: PrismaClient | null = input.deps?.prisma ?? null;
    if (!prisma && !input.deps?.ensureBaseReportRun && !input.deps?.fixtureBaseRows) {
      try {
        prisma = (await import("@/server/prisma/client")).prisma;
      } catch {
        prisma = null;
      }
    }

    const renderResume = elig2.recoveryReason === "RENDER_RESUME";
    const ingestResume = elig2.recoveryReason === "ARSENKIN_INGEST_RESUME";
    const assemblyResume = elig2.recoveryReason === "ASSEMBLY_RESUME";
    const ensure = input.deps?.ensureBaseReportRun ?? ensurePersistedUnifiedBaseReportRun;
    let baseReportRunId: string;
    let createdBaseReportRun = false;

    if (renderResume && job.baseReportRunId) {
      // Render checkpoint: reuse existing persisted base run — never recollect.
      baseReportRunId = job.baseReportRunId;
      createdBaseReportRun = false;
    } else if (input.deps?.ensureBaseReportRun || prisma) {
      if (!prisma && !input.deps?.ensureBaseReportRun) {
        throw new ConflictError("BASE_REPORT_RUN_PERSIST_UNAVAILABLE");
      }
      const ensured = await ensure({
        prisma: prisma as PrismaClient,
        caseId: job.caseId,
        unifiedJobId: job.unifiedJobId,
        existingBaseReportRunId: job.baseReportRunId ?? manifest.baseReportRunId,
      });
      baseReportRunId = ensured.baseReportRunId;
      createdBaseReportRun = ensured.created;
    } else if (input.deps?.fixtureBaseRows) {
      baseReportRunId =
        job.baseReportRunId ??
        manifest.baseReportRunId ??
        `fixture-base-${job.unifiedJobId}`;
      createdBaseReportRun = !job.baseReportRunId && !manifest.baseReportRunId;
    } else if (job.baseReportRunId) {
      baseReportRunId = job.baseReportRunId;
      createdBaseReportRun = false;
    } else {
      throw new ConflictError("BASE_REPORT_RUN_PERSIST_UNAVAILABLE");
    }

    if (!renderResume) {
      const nextManifest: BaseCollectionManifest = { ...manifest, baseReportRunId };
      await writeUnifiedArtifact(
        job.caseId,
        job.unifiedJobId,
        "base-collection-manifest.json",
        nextManifest
      );

      const existingBinding = await readUnifiedArtifact<ReportDataBinding>(
        job.caseId,
        job.unifiedJobId,
        "report-data-binding.json"
      );
      if (existingBinding) {
        await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "report-data-binding.json", {
          ...existingBinding,
          baseReportRunId,
        });
      }
    }

    const recoveryAudit: UnifiedRecoveryAudit = {
      recoveredFromStatus: job.status,
      recoveredFromStage: job.stage,
      recoveryRequestedAt: nowFn().toISOString(),
      recoveryRequestedBy: input.actorId,
      recoveryReason: elig2.recoveryReason ?? "RECOVERY",
      previousLastError: job.lastError,
      previousLastErrorCode: job.lastErrorCode,
    };

    const nextStage =
      renderResume || assemblyResume ? "ORION_PREPARE" : "ARSENKIN_ENRICHMENT";
    // Место остановки внутри шага; сама стадия задаётся `nextStage` выше.
    // «Начать обогащение сначала» внутренней позицией не является — там был
    // дубль стадии, который никто не читал (шаг 12.4c).
    const resumeCheckpoint = renderResume
      ? "RENDER"
      : ingestResume && !assemblyResume
        ? "ARSENKIN_RESULT_INGEST"
        : null;
    const artifactsDir = unifiedArtifactsDir(job.caseId, job.unifiedJobId);

    // Ingest recovery: mark stale composite/analytics/section/render lineage before new observations land.
    if (ingestResume) {
      const { invalidateDownstreamAfterEnrichmentIngest } = await import(
        "./unified-downstream-invalidation"
      );
      await invalidateDownstreamAfterEnrichmentIngest({
        job,
        reason: "arsenkin-ingest-recovery",
        previousCompositeDatasetId: job.compositeDatasetId,
      });
    }

    if (renderResume) {
      const binding = await readUnifiedArtifact<ReportDataBinding>(
        job.caseId,
        job.unifiedJobId,
        "report-data-binding.json"
      );
      const reusable = binding
        ? loadReusableAssembledDeck({
            artifactsDir,
            caseId: job.caseId,
            expectedDatasetId: binding.compositeDatasetId,
          })
        : null;
      await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "render-checkpoint.json", {
        version: "render-checkpoint-v1",
        stage: "RENDER",
        status: reusable ? "READY" : "NEEDS_ASSEMBLY",
        assemblyHash: reusable?.assemblyHash ?? null,
        caseId: job.caseId,
        unifiedJobId: job.unifiedJobId,
        updatedAt: nowFn().toISOString(),
      });
    }

    const nowIso = nowFn().toISOString();

    // Ingest resume: remap empty failed unified runs → sibling CaseAgent runs
    // that already have DONE ProviderTasks (same pattern as Suggestions remap).
    let enrichmentRunIds = job.enrichmentRunIds;
    let arsenkinEnrichmentState = job.arsenkinEnrichmentState ?? undefined;
    const siblingRemapWarnings: string[] = [];
    if (ingestResume) {
      const { remapFailedEnrichmentRunsToSiblings } = await import(
        "./unified-enrichment-sibling-remap"
      );
      const remapped = await remapFailedEnrichmentRunsToSiblings({
        caseId: job.caseId,
        job,
        deps: input.deps?.siblingRemap,
      });
      if (remapped.changed) {
        enrichmentRunIds = remapped.enrichmentRunIds;
        arsenkinEnrichmentState = remapped.arsenkinEnrichmentState ?? undefined;
        siblingRemapWarnings.push(
          `sibling-remap:${remapped.remaps.length}`,
          ...remapped.remaps.map(
            (r) => `sibling-remap:${r.agentName}:${r.fromRunId}->${r.toRunId}`
          )
        );
        await writeUnifiedArtifact(
          job.caseId,
          job.unifiedJobId,
          "enrichment-sibling-remap-audit.json",
          {
            version: "enrichment-sibling-remap-audit-v1",
            at: nowIso,
            remaps: remapped.remaps,
            enrichmentRunIds: remapped.enrichmentRunIds,
          }
        );
      }
    }

    const patched =
      await patchUnifiedCollectionJob(job.caseId, {
        stage: nextStage,
        status: "WAITING",
        baseReportRunId,
        resumeCheckpoint,
        // Ingest recovery must rebuild composite/analytics/render after observations land.
        compositeDatasetId: ingestResume ? null : job.compositeDatasetId,
        reportLinks: ingestResume ? {} : job.reportLinks,
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        // Ceiling reset so durable poll can resume the same paid externalTaskIds.
        pollAttempt: ingestResume || renderResume ? 0 : job.pollAttempt ?? 0,
        // Общий срок ожидания отсчитывается заново: это осознанное решение
        // человека, который видит очередь провайдера. Автоматическому пути
        // такого права нет — иначе ограничения не существовало бы (шаг 14).
        enrichmentWaitStartedAt: ingestResume ? null : job.enrichmentWaitStartedAt ?? null,
        nextPollAt: ingestResume ? nowIso : job.nextPollAt ?? null,
        // Keep enrichment lineage; do not wipe progress artifact binding.
        arsenkinEnrichmentState,
        enrichmentRunIds,
        recoveryAudit,
        warnings: [
          ...job.warnings.filter((w) => !/recovery-accepted/i.test(w)),
          `recovery-accepted:${elig2.recoveryReason}`,
          ingestResume ? "pollAttempt-reset:0" : "",
          ...siblingRemapWarnings,
          renderResume
            ? "bounded-resume:from-render"
            : assemblyResume
              ? "bounded-resume:from-assembly"
              : ingestResume
                ? "bounded-resume:from-arsenkin-ingest"
                : "bounded-resume:from-arsenkin",
        ].filter(Boolean),
      }) ?? job;

    if (assemblyResume) {
      await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "force-gpt-copy.json", {
        version: "force-gpt-copy-v1",
        requestedAt: nowIso,
        requestedBy: input.actorId,
        reason: "assembly-resume-recovery",
      });
    }

    await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "unified-recovery-audit.json", recoveryAudit);

    return {
      accepted: true,
      jobId: patched.jobId,
      unifiedJobId: patched.unifiedJobId,
      stage: nextStage,
      status: "WAITING",
      baseReportRunId,
      recoveryReason: elig2.recoveryReason ?? "RECOVERY",
      createdBaseReportRun,
      idempotent: false,
    };
  } finally {
    await releaseUnifiedJobLease(input.caseId, ownerId);
    // Разбудить остановившийся шаг до тика: иначе воркер не узнает, что
    // работа снова готова, и восстановление осталось бы бумажным.
    const current = await loadUnifiedCollectionJob(input.caseId);
    if (current) await requeueResumeStep(current, nowFn());
    await scheduleRecoverTick(input.caseId, input.deps);
  }
}

/** Attach server-calculated recovery fields for GET status. */
export async function withUnifiedRecoveryStatusFields(job: UnifiedCollectionJob | null): Promise<{
  recoveryAllowed: boolean;
  recoveryBlockerReason: string | null;
  recoveryReason: string | null;
}> {
  if (!job) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_NOT_FOUND",
      recoveryReason: null,
    };
  }
  const elig = await evaluateUnifiedCollectionRecoveryEligibility({
    caseId: job.caseId,
    job,
  });
  return {
    recoveryAllowed: elig.recoveryAllowed,
    recoveryBlockerReason: elig.recoveryBlockerReason,
    recoveryReason: elig.recoveryReason,
  };
}
