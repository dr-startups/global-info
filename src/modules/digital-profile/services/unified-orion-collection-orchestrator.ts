/**
 * Unified ORION collection orchestrator.
 * BASE (existing runFullAudit) → Arsenkin enrichment → composite → prepare → REPORT_READY.
 * Does not rewrite Yandex/Serper / runOrionSearchProfile.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  claimUnifiedJobLease,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  listResumableUnifiedJobs,
  patchUnifiedCollectionJob,
  readUnifiedArtifact,
  releaseUnifiedJobLease,
  unifiedArtifactsDir,
  writeUnifiedArtifact,
} from "./unified-collection-job-store";
import type {
  BaseCollectionManifest,
  ReportDataBinding,
  SurfaceCoverageBreakdown,
  UnifiedCollectionJob,
} from "./unified-collection-types";
import {
  computeCoverageProgress,
  emptyCoverage,
  FIRST36_PLANNED_SUPPORTED_SURFACES,
} from "./unified-collection-types";
import {
  assessRealCollection,
  captureBaseCollectionManifest,
  mapFullAuditToActualProviders,
  snapshotExistingIds,
} from "./base-collection-manifest";
import {
  buildReportDataBinding,
  mergeCompositeSerp,
  type CompositeMergeResult,
  type CompositeObservation,
} from "./composite-serp-merge";
import {
  assertReportReadyGates,
  gptLayerAppliedFromQuality,
} from "./report-ready-gates";
import { digitalProfileConfig } from "../config";
import {
  ensureOfflineEnrichmentJobWarning,
  isOfflineEnrichmentMode,
} from "../config/offline-enrichment-guard";
import { assertPreRenderDataGates } from "./pre-render-data-gates";
import {
  runCanonicalReportPrepare,
  CanonicalPrepareBlockedError,
} from "./canonical-report-prepare";
import {
  buildReportQualitySummary,
  buildReportQualityWarnings,
  mergeJobWarnings,
  toJobReportQuality,
  type JobReportQuality,
} from "./report-quality-summary";
import type { DeckRenderAdapter } from "./render-deck-artifacts";
import { resolveJobSubjectProfile } from "./job-subject-profile";
import {
  bootstrapSubjectProfileFromCollection,
  type CaseSubjectRef,
} from "./job-subject-profile-bootstrap";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import { invalidateDownstreamAfterEnrichmentIngest } from "./unified-downstream-invalidation";
import { normalizeArsenkinEnrichmentState } from "./arsenkin-enrichment-state";
import type { FullAuditResultDTO } from "./agent-run-service";
import { ensurePersistedUnifiedBaseReportRun } from "./unified-base-report-run";
import { ARSENKIN_REAL_AGENT_NAMES } from "../agents/real/real-arsenkin-agents";
import { evaluateUnifiedCollectionRecoveryEligibility } from "./unified-collection-recovery";
import { ConflictError } from "../http/errors";
import type { ArsenkinEnrichmentState, ArsenkinAgentProgress } from "./arsenkin-enrichment-state";
import {
  legacyEnrichmentResultToTick,
  offlineSyntheticCompleteTick,
  runDurableArsenkinEnrichmentTick,
  type EnrichmentPollTaskSnap,
} from "./arsenkin-enrichment-tick";
import { buildBaseObservationCoverage } from "./base-observation-coverage";
import { prepareGateFailureMessage } from "./prepare-gate-advice";
import {
  deriveEnrichmentProgress,
  detectEnrichmentProgressDrift,
  enrichmentDriftWarnings,
} from "./arsenkin-progress-derivation";
import {
  MAX_IDLE_POLLS,
  decideEnrichmentPoll,
  markEnrichmentProgress,
  pollBackoffMs,
} from "./arsenkin-poll-budget";
import {
  runUnifiedComplianceScreening,
  screeningWarning,
} from "./unified-compliance-screening";

/** Bounded delay before re-scheduling a WAITING Arsenkin ingest tick. */
export function computeUnifiedPollDelayMs(job: UnifiedCollectionJob, now = Date.now()): number {
  if (job.nextPollAt) {
    const due = Date.parse(job.nextPollAt);
    if (!Number.isNaN(due)) return Math.max(50, due - now);
  }
  const attempt = Math.max(0, Number(job.pollAttempt ?? 0));
  return Math.min(30_000, Math.max(50, 2_000 * 2 ** Math.min(attempt, 4)));
}

/**
 * Потолок опросов Arsenkin без продвижения (шаг 14).
 *
 * Раньше считались **все** опросы, включая те, где провайдер честно работал, и
 * потолок срабатывал на здоровом двадцатиминутном прогоне. Теперь это предел
 * тишины: столько опросов подряд без единого сдвига.
 *
 * Имя сохранено — на константу ссылаются смоки.
 */
export const MAX_ARSENKIN_INGEST_POLL_ATTEMPTS = MAX_IDLE_POLLS;

/**
 * A tick whose polls were all rejected by the in-process live-auth singleton
 * (`withExistingExternalTaskPollAuthorization` refuses to nest inside an open
 * `/set` session) never talked to Arsenkin at all. Counting it against the poll
 * budget lets internal lock contention alone exhaust the 40 attempts and fail a
 * job whose provider tasks are all completing normally — observed on a live run
 * where every ProviderTask reached DONE while the job died RETRYABLE.
 */
const POLL_AUTH_BLOCKED_CODE = "ARSENKIN_POLL_AUTH_BLOCKED";

export function isPollAuthContentionOnly(warnings: readonly string[]): boolean {
  let blocked = false;
  for (const w of warnings) {
    if (w.startsWith(`${POLL_AUTH_BLOCKED_CODE}:`)) {
      blocked = true;
      continue;
    }
    // Any other poll diagnostic means the tick did real provider work.
    if (/^ARSENKIN_POLL_(?!AUTH_BLOCKED)/.test(w) || w.startsWith("httpStatus:")) return false;
  }
  return blocked;
}

function logUnifiedTickError(input: {
  caseId: string;
  jobId?: string | null;
  providerTaskId?: string | null;
  externalTaskId?: string | null;
  agentName?: string | null;
  errorCode: string;
  error: unknown;
}): void {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  console.error(
    JSON.stringify({
      event: "unified_tick_error",
      caseId: input.caseId,
      jobId: input.jobId ?? null,
      providerTaskId: input.providerTaskId ?? null,
      externalTaskId: input.externalTaskId ?? null,
      agentName: input.agentName ?? null,
      errorCode: input.errorCode,
      message: message.slice(0, 500),
    })
  );
}

function extractTickErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return String((err as { code: string }).code);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/ARSENKIN_SCHEMA_INVALID/i.test(msg)) return "ARSENKIN_SCHEMA_INVALID";
  if (/ARSENKIN_POLL/i.test(msg)) return "ARSENKIN_POLL_FAILED";
  return "UNIFIED_TICK_FAILED";
}

/**
 * Persist tick/poll failures so lease churn cannot continue without pollAttempt/nextPollAt.
 * Never swallows — caller logs via logUnifiedTickError first.
 */
export async function persistUnifiedTickFailure(
  caseId: string,
  err: unknown,
  extras?: {
    providerTaskId?: string | null;
    externalTaskId?: string | null;
    agentName?: string | null;
    now?: Date;
  }
): Promise<UnifiedCollectionJob | null> {
  const job = await loadUnifiedCollectionJob(caseId);
  if (!job) return null;
  const errorCode = extractTickErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  logUnifiedTickError({
    caseId,
    jobId: job.jobId,
    providerTaskId: extras?.providerTaskId,
    externalTaskId: extras?.externalTaskId,
    agentName: extras?.agentName,
    errorCode,
    error: err,
  });
  // Опрос, завершившийся ошибкой, продвижением не является — он тратит тот же
  // бюджет тишины, что и опрос без изменений (шаг 14).
  const attempt = Math.max(0, Number(job.pollAttempt ?? 0)) + 1;
  const nowMs = (extras?.now ?? new Date()).getTime();
  const nextPollAt = new Date(nowMs + pollBackoffMs(attempt)).toISOString();
  if (attempt >= MAX_ARSENKIN_INGEST_POLL_ATTEMPTS) {
    return await failRetryable(
      job,
      "ARSENKIN_POLL_ATTEMPTS_EXCEEDED",
      `Опрос Arsenkin не удаётся ${attempt} раз подряд: ${message.slice(0, 400)}`,
      [
        "ARSENKIN_RESULT_INGEST",
        `idlePolls:${attempt}`,
        errorCode,
        extras?.externalTaskId ? `externalTaskId:${extras.externalTaskId}` : "",
        extras?.providerTaskId ? `providerTaskId:${extras.providerTaskId}` : "",
        extras?.agentName ? `agentName:${extras.agentName}` : "",
      ].filter(Boolean)
    );
  }
  return (
    await patchUnifiedCollectionJob(caseId, {
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      pollAttempt: attempt,
      nextPollAt,
      lastError: message.slice(0, 500),
      lastErrorCode: errorCode,
      warnings: [
        ...job.warnings,
        `unified-tick-error:${errorCode}`,
        extras?.externalTaskId ? `externalTaskId:${extras.externalTaskId}` : "",
        extras?.agentName ? `agentName:${extras.agentName}` : "",
      ].filter(Boolean),
      completedAt: null,
    }) ?? job
  );
}

export type UnifiedOrchestratorDeps = {
  prisma?: PrismaClient | null;
  runFullAudit?: (caseId: string, actorId: string) => Promise<FullAuditResultDTO>;
  /** Offline: ProviderTasks for durable enrichment poll/ingest. */
  listEnrichmentProviderTasks?: (enrichmentRunIds: string[]) => Promise<EnrichmentPollTaskSnap[]>;
  /** Offline: poll adapter (never /set). */
  pollEnrichmentTask?: (task: EnrichmentPollTaskSnap) => Promise<EnrichmentPollTaskSnap>;
  /**
   * Arsenkin enrichment tick (may be incomplete). Prefer enrichmentComplete flag.
   * Schedule-only (enrichmentRunIds length 5) is NOT completion.
   */
  runArsenkinEnrichment?: (job: UnifiedCollectionJob) => Promise<{
    arsenkinReportRunId: string | null;
    enrichmentRunIds?: string[];
    coverage?: SurfaceCoverageBreakdown;
    observations: Array<{
      region?: string;
      engine?: string;
      query?: string;
      url?: string;
      title?: string;
      snippet?: string;
      suggestion?: string;
      question?: string;
      kind?: "organic" | "suggestion" | "paa" | "other";
      providerTaskId?: string | null;
      riskLabel?: string | null;
      externalTaskId?: string | null;
      caseAgent?: string;
      tool?: string | null;
      enrichmentRunId?: string;
      unifiedJobId?: string;
      sourceUrlOrQuery?: string | null;
      resultHash?: string | null;
    }>;
    warnings?: string[];
    partial?: boolean;
    enrichmentComplete?: boolean;
    agents?: ArsenkinAgentProgress[];
    blockPipeline?: boolean;
    blockCode?: string;
    blockMessage?: string;
  }>;
  /**
   * Override the canonical prepare (tests). Returns the dataset id prepare
   * actually consumed (for the fail-closed gate) plus one-assembly/one-render
   * counts. When omitted, the canonical job-scoped pipeline runs.
   */
  runPrepare?: (input: {
    caseId: string;
    binding: ReportDataBinding;
    merge: CompositeMergeResult;
  }) => Promise<{
    prepareDatasetId: string;
    pdf?: string;
    pptx?: string;
    contactSheet?: string;
    assemblyCount?: number;
    renderCount?: number;
    reportQuality?: JobReportQuality | null;
    qualityWarnings?: string[];
  }>;
  /** Subject identity for canonical prepare (production resolves from the case). */
  subjectProfile?: ClassifierSubjectProfile | null;
  /** Case subject for the automatic profile bootstrap (offline tests inject it). */
  caseSubject?: CaseSubjectRef | null;
  /** Injectable renderer for canonical prepare (default: local python). */
  renderDeck?: DeckRenderAdapter;
  fixtureBaseRows?: CompositeObservation[];
  allowMockReport?: boolean;
  /** When false, caller must drain ticks manually (tests). Default true. */
  autoSchedule?: boolean;
  now?: () => Date;
};

function stageProgress(stage: UnifiedCollectionJob["stage"]): number {
  switch (stage) {
    case "BASE_COLLECTION":
      return 0.1;
    case "ARSENKIN_ENRICHMENT":
      return 0.35;
    case "COMPOSITE_MERGE":
      return 0.55;
    case "ORION_PREPARE":
      return 0.7;
    case "CLIENT_CONTENT":
      return 0.85;
    case "REPORT_READY":
      return 1;
    case "COMPLETED_PARTIAL":
      return 0.95;
    default:
      return 0.05;
  }
}

/**
 * Resume without re-collecting base providers when the base manifest +
 * baseReportRunId already exist. RENDER checkpoint resumes at ORION_PREPARE
 * (render-only) — never Arsenkin/base.
 */
/** True when a job retains stages/artifacts that must not be silently recollected. */
export function unifiedJobHasPreservedStages(job: UnifiedCollectionJob | null | undefined): boolean {
  if (!job) return false;
  if (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL") return true;
  if (job.baseReportRunId || (job.enrichmentRunIds?.length ?? 0) > 0 || job.compositeDatasetId) {
    return true;
  }
  return Object.keys(job.artifactPaths ?? {}).length > 0;
}

async function resumeFromRetryableCheckpoint(job: UnifiedCollectionJob): Promise<UnifiedCollectionJob> {
  const renderResume =
    job.resumeCheckpoint === "RENDER" ||
    job.lastErrorCode === "RENDER_FAILED" ||
    /render failed/i.test(job.lastError ?? "");

  const enrichmentComplete = Boolean(job.arsenkinEnrichmentState?.enrichmentComplete);
  const ingestResume =
    job.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" ||
    ((job.enrichmentRunIds?.length ?? 0) >= ARSENKIN_REAL_AGENT_NAMES.length &&
      !enrichmentComplete &&
      Boolean(job.baseReportRunId));

  if (
    renderResume &&
    job.baseReportRunId &&
    (job.enrichmentRunIds?.length ?? 0) >= 5 &&
    enrichmentComplete
  ) {
    return (
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "ORION_PREPARE",
        status: "RUNNING",
        resumeCheckpoint: "RENDER",
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        warnings: [...job.warnings, "bounded-resume:from-render"],
      }) ?? job
    );
  }

  const manifest = await readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  const hasBase =
    Boolean(job.baseReportRunId || manifest?.baseReportRunId) &&
    Boolean(manifest) &&
    (manifest!.baseCount > 0 ||
      manifest!.searchResultIds.length + manifest!.searchSurfaceItemIds.length > 0);

  // Full prepare retry after section/assembly QA failure — no re-collection.
  const assemblyResume =
    job.resumeCheckpoint === "ASSEMBLY" ||
    // Прогоны до переименования (шаг 12.4c) хранят прежнее значение.
    job.resumeCheckpoint === "ORION_PREPARE" ||
    job.lastErrorCode === "ASSEMBLY_FAILED" ||
    job.lastErrorCode === "REQUIRED_SECTION_FAILED" ||
    /required sections failed/i.test(job.lastError ?? "");
  if (assemblyResume && hasBase && job.compositeDatasetId) {
    return (
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "ORION_PREPARE",
        status: "RUNNING",
        resumeCheckpoint: null,
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        warnings: [...job.warnings, "bounded-resume:from-assembly"],
      }) ?? job
    );
  }

  if (hasBase && ingestResume) {
    return (
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "ARSENKIN_ENRICHMENT",
        status: "RUNNING",
        resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
        baseReportRunId: job.baseReportRunId ?? manifest!.baseReportRunId,
        // Счётчик простоя обнуляется, иначе возобновление сразу упирается в тот
        // же предел и «повторяемый отказ» оказывается неправдой. Именно здесь
        // расходились автоматический путь и кнопка: ручное восстановление
        // обнуляло счётчик, а этот — нет, поэтому оркестрация ложилась на
        // пользователя (шаг 14).
        pollAttempt: 0,
        // Общий срок ожидания при этом НЕ продлевается: он и ограничивает
        // худший случай, сколько бы возобновлений ни случилось.
        enrichmentWaitStartedAt: job.enrichmentWaitStartedAt ?? null,
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        warnings: [...job.warnings, "bounded-resume:from-arsenkin-ingest"],
      }) ?? job
    );
  }

  if (hasBase) {
    return (
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "ARSENKIN_ENRICHMENT",
        status: "RUNNING",
        // Внутри шага возобновляться некуда: обогащение начинается сначала.
        // Дублировать здесь стадию нечем и незачем (шаг 12.4c).
        resumeCheckpoint: null,
        baseReportRunId: job.baseReportRunId ?? manifest!.baseReportRunId,
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        warnings: [...job.warnings, "bounded-resume:from-arsenkin"],
      }) ?? job
    );
  }

  return (
    await patchUnifiedCollectionJob(job.caseId, {
      stage: "BASE_COLLECTION",
      status: "RUNNING",
      resumeCheckpoint: null,
      lastError: null,
      lastErrorCode: null,
      completedAt: null,
      warnings: [...job.warnings, "bounded-resume:from-base"],
    }) ?? job
  );
}

/**
 * Отказ, который повтором не лечится.
 *
 * Используется там, где возобновление упрётся в то же условие сразу же —
 * например, исчерпан общий срок ожидания обогащения. Предлагать оператору
 * кнопку в таком случае значит звать его чинить то, что кнопкой не чинится.
 */
/**
 * Продвижение, видимое в базе: завершённые задачи провайдера и сохранённые
 * наблюдения.
 *
 * Сводное состояние джобы обновляется только на границах агентов — пять
 * агентов идут по очереди, и пока первый работает, в сводке всё по нулям.
 * Строки задач при этом переходят в `DONE` по одной, и именно они честно
 * отвечают на вопрос «провайдер работает или молчит» (шаг 14, живой прогон).
 *
 * Сбой чтения не должен обрывать прогон: нули означают «сведений нет», и
 * решение принимается по остальным признакам.
 */
async function countLiveEnrichmentProgress(
  caseId: string,
  deps: UnifiedOrchestratorDeps
): Promise<{ doneProviderTasks: number; persistedObservations: number }> {
  try {
    const prisma = deps.prisma ?? (await import("@/server/prisma/client")).prisma;
    const [doneProviderTasks, persistedObservations] = await Promise.all([
      prisma.providerTask.count({ where: { caseId, state: "DONE" } }),
      prisma.serpObservation.count({ where: { caseId } }),
    ]);
    return { doneProviderTasks, persistedObservations };
  } catch {
    return { doneProviderTasks: 0, persistedObservations: 0 };
  }
}

/**
 * Заводит строку запуска агента, если её ещё нет.
 *
 * Идемпотентно: повторная отправка того же агента в том же прогоне не плодит
 * вторых строк. Неудача записи прогон не роняет — это отображение хода работы,
 * а не источник правды конвейера.
 */
async function ensureUnifiedAgentRun(input: {
  id: string;
  caseId: string;
  agentName: string;
  actorId?: string | null;
  prisma?: PrismaClient;
}): Promise<void> {
  try {
    const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
    await prisma.agentRun.upsert({
      where: { id: input.id },
      update: {},
      create: {
        id: input.id,
        caseId: input.caseId,
        agentName: input.agentName as never,
        status: "RUNNING",
        startedAt: new Date(),
        triggeredBy: input.actorId ?? null,
      },
    });
  } catch (err) {
    console.warn(
      `[unified] строка запуска ${input.agentName} не заведена:`,
      err instanceof Error ? err.message : err
    );
  }
}


/**
 * Сверяет хранимый прогресс обогащения с выведенным из строк задач.
 *
 * Возвращает предупреждения; пустой список — ответы совпадают. Сбой чтения
 * молчит: детектор вспомогательный, и его неудача не должна ронять прогон.
 */
async function detectStoredEnrichmentDrift(
  job: UnifiedCollectionJob,
  state: ArsenkinEnrichmentState | null | undefined,
  deps: UnifiedOrchestratorDeps
): Promise<string[]> {
  try {
    const prisma = deps.prisma ?? (await import("@/server/prisma/client")).prisma;
    const { agentNameFromEnrichmentRunId } = await import("./unified-enrichment-sibling-remap");
    const runIds = (job.enrichmentRunIds ?? []).filter(Boolean);
    if (runIds.length === 0) return [];
    const rows = await prisma.providerTask.findMany({
      where: { caseId: job.caseId, reportRunId: { in: runIds } },
      select: { reportRunId: true, state: true },
    });
    const byAgent: Record<string, string | null> = {};
    for (const agent of ARSENKIN_REAL_AGENT_NAMES) {
      byAgent[agent] =
        runIds.find((r) => agentNameFromEnrichmentRunId(r) === agent) ?? null;
    }
    const derived = deriveEnrichmentProgress({
      enrichmentRunIdByAgent: byAgent,
      tasks: rows.map((r) => ({ reportRunId: String(r.reportRunId ?? ""), state: String(r.state) })),
      observationCount: Number(state?.enrichmentObservationCount ?? 0),
    });
    const drift = detectEnrichmentProgressDrift(state, derived);
    if (drift.length > 0) {
      console.warn(
        `[unified] прогресс обогащения расходится с задачами: ` +
          drift.map((d) => `${d.field} ${d.stored}!=${d.derived}`).join("; ")
      );
    }
    return enrichmentDriftWarnings(drift);
  } catch {
    return [];
  }
}


async function failTerminal(
  job: UnifiedCollectionJob,
  code: string,
  message: string,
  extraWarnings: string[] = []
): Promise<UnifiedCollectionJob> {
  return (
    await patchUnifiedCollectionJob(job.caseId, {
      stage: "FAILED_TERMINAL",
      status: "FAILED",
      lastError: message,
      lastErrorCode: code,
      arsenkinEnrichmentState: job.arsenkinEnrichmentState ?? undefined,
      enrichmentRunIds: job.enrichmentRunIds,
      baseReportRunId: job.baseReportRunId,
      warnings: [...job.warnings, ...extraWarnings, code],
      completedAt: new Date().toISOString(),
    }) ?? job
  );
}

async function failRetryable(
  job: UnifiedCollectionJob,
  code: string,
  message: string,
  extraWarnings: string[] = []
): Promise<UnifiedCollectionJob> {
  const resumeCheckpoint =
    code === "RENDER_FAILED" || extraWarnings.some((w) => /render-checkpoint:RENDER/i.test(w))
      ? ("RENDER" as const)
      : code === "ASSEMBLY_FAILED" ||
          code === "REQUIRED_SECTION_FAILED" ||
          extraWarnings.some((w) => /retryable-assembly-failure/i.test(w))
        ? ("ASSEMBLY" as const)
        : code === "PRE_RENDER_DATA_GATE_FAILED" ||
            extraWarnings.some((w) => /PRE_RENDER_DATA_GATE/i.test(w))
          ? ("PRE_RENDER_DATA_GATE" as const)
          : code === "ARSENKIN_ENRICHMENT_INCOMPLETE" ||
              code === "ARSENKIN_ENRICHMENT_FAILED" ||
              code === "ARSENKIN_SUBMIT_UNKNOWN" ||
              code === "ARSENKIN_SCHEMA_INVALID" ||
              code === "ARSENKIN_POLL_ATTEMPTS_EXCEEDED" ||
              code === "UNIFIED_TICK_FAILED" ||
              code === "EXTERNAL_TASK_HASH_CONFLICT" ||
              extraWarnings.some((w) => /arsenkin-ingest|ARSENKIN_RESULT_INGEST/i.test(w))
            ? ("ARSENKIN_RESULT_INGEST" as const)
            : job.resumeCheckpoint ?? null;
  return (
    await patchUnifiedCollectionJob(job.caseId, {
      stage: "FAILED_RETRYABLE",
      status: "WAITING",
      lastError: message,
      lastErrorCode: code,
      resumeCheckpoint,
      // Preserve enrichment progress for UI + exact resume (never wipe on fail).
      arsenkinEnrichmentState: job.arsenkinEnrichmentState ?? undefined,
      enrichmentRunIds: job.enrichmentRunIds,
      baseReportRunId: job.baseReportRunId,
      warnings: [...job.warnings, ...extraWarnings, code],
      completedAt: new Date().toISOString(),
    }) ?? job
  );
}

export async function startUnifiedOrionCollection(input: {
  caseId: string;
  requestedBy?: string;
  arsenkinMode?: "full-first36";
  /** Explicit paid recollection — required to supersede a job with preserved stages. */
  confirmPaidRecollection?: boolean;
  deps?: UnifiedOrchestratorDeps;
}): Promise<{ accepted: true; jobId: string; unifiedJobId: string; created: boolean; stage: string }> {
  const existing = await loadUnifiedCollectionJob(input.caseId);
  if (existing) {
    const elig = await evaluateUnifiedCollectionRecoveryEligibility({
      caseId: input.caseId,
      job: existing,
    });
    // Durable post-submit / ingest wait: always resume the same job (never 409 / new collection).
    const inFlightArsenkinIngest =
      existing.stage === "ARSENKIN_ENRICHMENT" &&
      (existing.status === "WAITING" || existing.status === "RUNNING") &&
      existing.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" &&
      (existing.enrichmentRunIds?.length ?? 0) >= ARSENKIN_REAL_AGENT_NAMES.length;
    // In-flight WAITING/RUNNING ingest or idempotent resume → reuse, do not 409.
    if (
      inFlightArsenkinIngest ||
      (elig.recoveryAllowed &&
        (existing.status === "WAITING" || existing.status === "RUNNING") &&
        (elig.recoveryReason === "ARSENKIN_INGEST_RESUME" ||
          elig.recoveryReason === "IDEMPOTENT_RESUME" ||
          elig.recoveryReason === "IDEMPOTENT_RENDER_RESUME"))
    ) {
      if (input.deps?.autoSchedule !== false) {
        scheduleUnifiedTick(input.caseId, input.deps);
      }
      return {
        accepted: true,
        jobId: existing.jobId,
        unifiedJobId: existing.unifiedJobId,
        created: false,
        stage: existing.stage,
      };
    }
    if (elig.recoveryAllowed) {
      throw new ConflictError(
        `recoverable unified job ${existing.jobId}; use POST /unified-collection/recover (${elig.recoveryReason})`
      );
    }
    if (unifiedJobHasPreservedStages(existing) && !input.confirmPaidRecollection) {
      throw new ConflictError(
        `unified job ${existing.jobId} has preserved stages/artifacts (${existing.stage}); ` +
          `use recovery or confirmPaidRecollection for a new paid collection`
      );
    }
  }

  const { job, created } = await findOrCreateUnifiedCollectionJob({
    caseId: input.caseId,
    requestedBy: input.requestedBy ?? "system",
    arsenkinMode: input.arsenkinMode ?? "full-first36",
    forceNew: Boolean(input.confirmPaidRecollection && existing && unifiedJobHasPreservedStages(existing)),
  });
  // REMEDIATION §8.2 — surface silent offline enrichment in deploy-like envs.
  let started = job;
  if (isOfflineEnrichmentMode()) {
    started =
      await patchUnifiedCollectionJob(job.caseId, {
        warnings: ensureOfflineEnrichmentJobWarning(job.warnings ?? []),
      }) ?? job;
  }
  // Шаг 12: расписание работы кладётся в БД, а не в таймер этого процесса.
  //
  // Тик здесь больше не выполняется. Раньше веб-процесс успевал продвинуть
  // джобу на следующую стадию до того, как воркер брал первый шаг, — и дальше
  // шаг и джоба расходились: шаг считал, что работа идёт, ждал вечно и сжигал
  // бюджет попыток, останавливая конвейер. Двое ведущих одну джобу — та же
  // болезнь, что и две правды о состоянии.
  if (input.deps?.autoSchedule !== false) {
    await enqueueUnifiedPipeline(started);
  }
  return {
    accepted: true,
    jobId: started.jobId,
    unifiedJobId: started.unifiedJobId,
    created,
    stage: started.stage,
  };
}

/**
 * Заводит конвейер шагов для прогона. Идемпотентно и не фатально: если таблица
 * шагов недоступна, прогон всё равно стартует — в переходный период его ещё
 * двигает внутрипроцессный планировщик.
 */
async function enqueueUnifiedPipeline(job: UnifiedCollectionJob): Promise<void> {
  try {
    const { ensurePipelineSteps } = await import("../workflow/step-store");
    await ensurePipelineSteps({ caseId: job.caseId, jobId: job.unifiedJobId });
  } catch (err) {
    console.error("[unified] не удалось завести конвейер шагов", err);
  }
}

const ticking = new Set<string>();

/**
 * Выполняет один тик немедленно, чтобы ответ на запуск не выглядел пустым.
 *
 * Продвижением дальше владеет воркер (шаг 12): расписание лежит в
 * `dp_workflow_steps.nextRunAt`, а не в таймере этого процесса. Здесь раньше
 * стояла цепочка `setTimeout`, из-за которой обычный деплой посреди сбора
 * бросал оплаченную работу — джоба оставалась в WAITING навсегда, потому что
 * будильник умирал вместе с процессом.
 */
export function scheduleUnifiedTick(caseId: string, deps: UnifiedOrchestratorDeps = {}): void {
  if (ticking.has(caseId)) return;
  ticking.add(caseId);
  setImmediate(() => {
    void runUnifiedCollectionTick(caseId, deps)
      .catch(async (err) => {
        // Never silent — persist pollAttempt/nextPollAt/error so lease churn stops.
        await persistUnifiedTickFailure(caseId, err, { now: deps.now?.() });
      })
      .finally(() => {
        ticking.delete(caseId);
      });
  });
}

/** Bounded resume after deploy — only active/retryable jobs. */
export async function resumeUnifiedCollectionsOnStartup(deps: UnifiedOrchestratorDeps = {}): Promise<void> {
  for (const { caseId } of await listResumableUnifiedJobs()) {
    scheduleUnifiedTick(caseId, deps);
  }
}

/**
 * Periodic pump for persisted WAITING unified jobs (durable across HTTP end).
 * Idempotent with scheduleUnifiedTick's in-process guard + job lease.
 */
export async function pumpResumableUnifiedCollections(deps: UnifiedOrchestratorDeps = {}): Promise<number> {
  const jobs = await listResumableUnifiedJobs();
  for (const { caseId } of jobs) {
    scheduleUnifiedTick(caseId, deps);
  }
  return jobs.length;
}

/** Сколько джоба считается «в работе» без признаков жизни. */
export const JOB_LEASE_MS = 120_000;

/**
 * Предельный возраст прогона. Дольше — он не жив, а висит.
 *
 * Самое долгое законное ожидание — обогащение Arsenkin, и оно измеряется
 * десятками минут. Шесть часов дают запас на порядок и при этом не дают
 * мёртвой джобе занимать подборщик вечно.
 */
export const UNIFIED_RUN_MAX_MS = 6 * 60 * 60 * 1000;

/** Через сколько лиза продлевается: треть срока — запас на две осечки. */
export const JOB_LEASE_HEARTBEAT_MS = Math.floor(JOB_LEASE_MS / 3);

export async function runUnifiedCollectionTick(
  caseId: string,
  deps: UnifiedOrchestratorDeps = {}
): Promise<UnifiedCollectionJob | null> {
  const ownerId = `unified-${process.pid}-${randomUUID().slice(0, 6)}`;
  const claimed = await claimUnifiedJobLease({ caseId, ownerId, leaseMs: JOB_LEASE_MS, now: deps.now?.() });
  if (!claimed) return await loadUnifiedCollectionJob(caseId);

  /*
   * Лиза джобы продлевается, пока тик работает.
   *
   * Лиза берётся на две минуты, а сборка отчёта идёт шесть: чтение ста
   * двадцати страниц, разбор моделью, отрисовка. Подборщик прогонов
   * (`pumpResumableUnifiedCollections`) опрашивает джобы каждые пять секунд;
   * как только лиза истекала, он запускал **второй тик той же джобы**, и
   * отчёт собирался параллельно сам с собой. На трёх прогонах подряд это
   * видно по логу: чтение ссылок и отрисовка отработали дважды с промежутком
   * около двух минут — ровно столько живёт лиза.
   *
   * Продление берёт ту же лизу тем же владельцем: если её всё-таки отобрали,
   * продление не пройдёт и не вернёт работу себе обманом.
   */
  const heartbeat = setInterval(() => {
    void claimUnifiedJobLease({ caseId, ownerId, leaseMs: JOB_LEASE_MS }).catch(() => {});
  }, JOB_LEASE_HEARTBEAT_MS);
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  try {
    let job = claimed;
    /*
     * Прогон, идущий шестой час, мёртв — и его надо закрыть, а не опрашивать
     * вечно.
     *
     * Подборщик берёт джобы в активных стадиях каждые пять секунд. Джоба,
     * застрявшая в такой стадии, остаётся в выборке навсегда: в логе вторые
     * сутки шло «подобрано прогонов: 1» от кейса, который никуда не двигался.
     * Вреда от него мало, но признак «работа идёт» он делает бессмысленным — и
     * оператор не видит, что прогон давно не жив.
     *
     * Шесть часов заведомо больше любого законного ожидания: самое долгое —
     * обогащение Arsenkin, и оно измеряется десятками минут.
     */
    const startedMs = job.startedAt ? Date.parse(job.startedAt) : NaN;
    const nowMs = deps.now?.().getTime() ?? Date.now();
    const ageMs = Number.isFinite(startedMs) ? nowMs - startedMs : 0;
    if (ageMs > UNIFIED_RUN_MAX_MS) {
      console.error(
        `[unified] прогон остановлен по возрасту: кейс=${job.caseId} джоба=${job.unifiedJobId} ` +
          `стадия=${job.stage} возраст=${Math.round(ageMs / 60000)} мин`
      );
      return await patchUnifiedCollectionJob(caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError:
          "Прогон не продвигался дольше шести часов и остановлен. Запустите сбор заново — данные предыдущих этапов сохранены.",
        lastErrorCode: "STALE_NO_PROGRESS",
        completedAt: new Date().toISOString(),
        warnings: [...job.warnings, "STALE_NO_PROGRESS"],
      });
    }
    if (job.cancelRequested) {
      return await patchUnifiedCollectionJob(caseId, {
        stage: "CANCELLED",
        status: "CANCELLED",
        completedAt: new Date().toISOString(),
      });
    }

    try {
      switch (job.stage) {
        case "BASE_COLLECTION":
          job = await stepBaseCollection(job, deps);
          break;
        case "ARSENKIN_ENRICHMENT":
          job = await stepArsenkin(job, deps);
          break;
        case "COMPOSITE_MERGE":
          job = await stepComposite(job, deps);
          break;
        case "ORION_PREPARE":
        case "CLIENT_CONTENT":
          job = await stepPrepare(job, deps);
          break;
        case "FAILED_RETRYABLE":
          // Explicit recovery only — background pump must not auto-lift FAILED_RETRYABLE.
          break;
        default:
          break;
      }
    } catch (err) {
      // Persist + stop silent lease churn; do not rethrow (scheduler catch is backup).
      await persistUnifiedTickFailure(caseId, err, { now: deps.now?.() });
    }
    return await loadUnifiedCollectionJob(caseId);
  } finally {
    clearInterval(heartbeat);
    await releaseUnifiedJobLease(caseId, ownerId);
  }
}


/** Marker the rebuild path leaves on the job for the duration of the attempt. */
const REBUILD_MARKER = "report-rebuild-accepted";

/**
 * Puts a job back the way it was when a report rebuild fails.
 *
 * Rebuilding report text runs analytics and render again over an already
 * collected dataset. A failure there says nothing about the collection, so it
 * must not cost the finished report: previously the job went FAILED_TERMINAL
 * and both /rebuild-report and /recover then refused it, stranding a completed
 * case whose PDF was still on disk (step 08.0-ter).
 *
 * Returns null when this run is not a rebuild or no snapshot was recorded, so
 * the caller falls through to its normal terminal handling.
 */
async function restoreAfterFailedRebuild(
  job: UnifiedCollectionJob,
  code: string,
  message: string
): Promise<UnifiedCollectionJob | null> {
  if (!job.warnings.some((w) => w === REBUILD_MARKER)) return null;
  const audit = await readUnifiedArtifact<{
    restoreSnapshot?: {
      stage: string;
      status: string;
      progress: number;
      completedAt: string | null;
      reportLinks: Record<string, string>;
    };
  }>(job.caseId, job.unifiedJobId, "unified-rebuild-audit.json");
  const snap = audit?.restoreSnapshot;
  if (!snap) return null;

  return (
    (await patchUnifiedCollectionJob(job.caseId, {
      stage: snap.stage as UnifiedCollectionJob["stage"],
      status: snap.status as UnifiedCollectionJob["status"],
      progress: snap.progress,
      completedAt: snap.completedAt,
      reportLinks: snap.reportLinks,
      lastError: null,
      lastErrorCode: null,
      warnings: [
        ...job.warnings.filter((w) => w !== REBUILD_MARKER),
        `report-rebuild-failed:${code}`,
        `report-rebuild-failed-detail:${message.slice(0, 160)}`,
      ],
    })) ?? job
  );
}

async function stepBaseCollection(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const runFullAudit =
    deps.runFullAudit ??
    (async (caseId: string, actorId: string) => {
      const { runFullAudit: real } = await import("./agent-run-service");
      // Evidence-first: on a real (non-mock) run an unconfigured provider must
      // be recorded as unavailable, never silently replaced by its mock agent.
      // The default `real_first_with_fallback` did the opposite — it wrote
      // synthetic SERP rows about a real subject into the corpus AND, because
      // `isRealCollectionSufficient` rejects any mock runtime, turned a partial
      // collection into a terminal PRE_RENDER_DATA_GATE_FAILED.
      return real(caseId, { actorId }, {
        runtimeMode: digitalProfileConfig.mockAgents ? undefined : "real_only",
      });
    });

  let before = { searchResultIds: new Set<string>(), searchSurfaceItemIds: new Set<string>() };
  let prisma: PrismaClient | null = deps.prisma ?? null;
  if (!prisma && deps.fixtureBaseRows == null) {
    try {
      prisma = (await import("@/server/prisma/client")).prisma;
    } catch {
      prisma = null;
    }
  }
  if (prisma) {
    before = await snapshotExistingIds(prisma, job.caseId);
  }

  const audit = await runFullAudit(job.caseId, job.requestedBy);
  const actualProviders = mapFullAuditToActualProviders(audit);

  let manifest: BaseCollectionManifest;
  if (deps.fixtureBaseRows) {
    manifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: job.unifiedJobId,
      caseId: job.caseId,
      capturedAt: new Date().toISOString(),
      baseReportRunId: job.baseReportRunId,
      searchResultIds: deps.fixtureBaseRows
        .map((r) => r.baseSearchResultId)
        .filter((x): x is string => Boolean(x)),
      searchSurfaceItemIds: deps.fixtureBaseRows
        .map((r) => r.baseSearchSurfaceItemId)
        .filter((x): x is string => Boolean(x)),
      caseCorpusSearchResultIds: [],
      caseCorpusSurfaceItemIds: [],
      baseCount: deps.fixtureBaseRows.length,
      actualProviders,
      realCollectionSufficient:
        actualProviders.some((p) => p.runtime === "real" && p.status === "completed") ||
        Boolean(deps.allowMockReport),
    };
  } else if (prisma) {
    manifest = await captureBaseCollectionManifest({
      prisma,
      caseId: job.caseId,
      unifiedJobId: job.unifiedJobId,
      beforeSearchResultIds: before.searchResultIds,
      beforeSearchSurfaceItemIds: before.searchSurfaceItemIds,
      actualProviders,
      baseReportRunId: job.baseReportRunId,
    });
  } else {
    return await failRetryable(
      job,
      "MANIFEST_CAPTURE_FAILED",
      "prisma unavailable for base-collection-manifest"
    );
  }

  // Persist a real OrionReportRun so Arsenkin + binding never see null.
  let baseReportRunId = manifest.baseReportRunId;
  if (prisma) {
    try {
      const ensured = await ensurePersistedUnifiedBaseReportRun({
        prisma,
        caseId: job.caseId,
        unifiedJobId: job.unifiedJobId,
        existingBaseReportRunId: baseReportRunId,
      });
      baseReportRunId = ensured.baseReportRunId;
      manifest = { ...manifest, baseReportRunId };
    } catch (err) {
      return await failRetryable(
        job,
        "BASE_REPORT_RUN_PERSIST_FAILED",
        err instanceof Error ? err.message : String(err),
        ["baseReportRunId-persist-failed"]
      );
    }
  } else if (deps.fixtureBaseRows) {
    // Offline: stable synthetic-but-job-scoped id is OK only when prisma is
    // absent AND tests supply fixture rows (no live Arsenkin).
    baseReportRunId = baseReportRunId ?? `fixture-base-${job.unifiedJobId}`;
    manifest = { ...manifest, baseReportRunId };
  }

  if (!baseReportRunId) {
    return await failRetryable(
      job,
      "BASE_REPORT_RUN_MISSING",
      "base collection completed but baseReportRunId was not persisted",
      ["arsenkin-blocked:no-baseReportRunId"]
    );
  }

  const path = await writeUnifiedArtifact(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json",
    manifest
  );

  // Проверка по санкционным перечням и спискам PEP — часть сбора, а не
  // отдельное нажатие (шаг 04.3). Отказ источника прогон не роняет: один
  // неответивший справочник не должен обнулять оплаченную работу.
  const screeningWarnings: string[] = [];
  if (!deps.fixtureBaseRows) {
    const outcome = await runUnifiedComplianceScreening({
      caseId: job.caseId,
      actorId: job.requestedBy,
    });
    const warning = screeningWarning(outcome);
    if (warning) screeningWarnings.push(warning);
  }

  return (
    await patchUnifiedCollectionJob(job.caseId, {
      stage: "ARSENKIN_ENRICHMENT",
      status: "RUNNING",
      progress: stageProgress("ARSENKIN_ENRICHMENT"),
      actualProviders,
      baseReportRunId,
      artifactPaths: { ...job.artifactPaths, baseCollectionManifest: path },
      warnings: [
        ...(manifest.realCollectionSufficient
          ? job.warnings
          : [...job.warnings, "base-collection used mock/fallback — REPORT_READY blocked unless allowMockReport"]),
        ...screeningWarnings,
      ],
    }) ?? job
  );
}

async function stepArsenkin(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const baseId = String(job.baseReportRunId ?? "").trim();
  if (!baseId) {
    return await failRetryable(
      job,
      "BASE_REPORT_RUN_MISSING",
      "Arsenkin enrichment requires persisted baseReportRunId — refuse silent skip",
      ["arsenkin-blocked:no-baseReportRunId"]
    );
  }

  const networkOff = String(process.env.NETWORK_CALLS ?? "") === "0";
  const hasOfflinePollDeps = Boolean(
    deps.listEnrichmentProviderTasks || deps.pollEnrichmentTask
  );
  const resumeIngest =
    job.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" &&
    (job.enrichmentRunIds?.length ?? 0) >= ARSENKIN_REAL_AGENT_NAMES.length;

  // Atomically persist pollAttempt + nextPollAt BEFORE HTTP poll (lease already held).
  // Prevents lease churn with missing poll progress when the tick throws mid-flight.
  if (resumeIngest) {
    // Расписание пишется ДО опроса, чтобы падение посреди тика не оставило
    // прогон без следующего срока. Счётчик простоя при этом не трогается: его
    // значение зависит от результата опроса, который ещё не сделан (шаг 14).
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    job =
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "ARSENKIN_ENRICHMENT",
        status: "WAITING",
        resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
        enrichmentWaitStartedAt:
          job.enrichmentWaitStartedAt ?? new Date(nowMs).toISOString(),
        nextPollAt: new Date(nowMs + pollBackoffMs(Number(job.pollAttempt ?? 0))).toISOString(),
        lastError: null,
        lastErrorCode: null,
      }) ?? job;
  }

  let tick;

  if (deps.runArsenkinEnrichment) {
    const raw = await deps.runArsenkinEnrichment(job);
    tick = legacyEnrichmentResultToTick(job, raw);
  } else if (networkOff && !hasOfflinePollDeps && !resumeIngest) {
    // Offline happy-path: honest EMPTY_VALID for all five — no live submits.
    // WAITING ingest resume / injected poll deps use the durable poll path instead.
    tick = offlineSyntheticCompleteTick(job);
  } else {
    tick = await runDurableArsenkinEnrichmentTick({
      job,
      prisma: deps.prisma,
      offlineEmptyValid: networkOff && !hasOfflinePollDeps && !resumeIngest,
      listProviderTasks: deps.listEnrichmentProviderTasks,
      pollTask: deps.pollEnrichmentTask,
      now: deps.now,
      // Отправка предлагается всегда: тик сам решает, кому она нужна, по
      // наличию строки ProviderTask. Прежде она подавлялась, как только было
      // зарегистрировано пять прогонов, — и агент, зарегистрированный без
      // отправленной задачи, опрашивался до исчерпания бюджета (шаг 08.0-bis).
      scheduleIfMissing: async (agentsToSubmit) => {
        const { startArsenkinCaseAgentDurable } = await import("./arsenkin-case-agent-execution");
        const { getAgent } = await import("../agents/registry");
        const { mergeAgentEnrichmentRunId } = await import("./unified-enrichment-sibling-remap");
        let enrichmentRunIds = [...(job.enrichmentRunIds ?? [])];
        const warnings: string[] = [];
        for (const agentName of agentsToSubmit) {
          const agent = getAgent(agentName);
          const tools =
            agent && "tools" in agent && Array.isArray((agent as { tools?: string[] }).tools)
              ? ((agent as { tools: import("../providers/arsenkin/flags").ArsenkinToolName[] }).tools)
              : [];
          const agentRunId = `unified-${job.unifiedJobId}-${agentName}`;
          // Строка запуска заводится ДО отправки: без неё итог агента писать
          // некуда, и во вкладке «Агенты» пять платных отправок не видны вовсе
          // (шаг 15, E10). Значения `ARSENKIN_*_REAL` добавлены в перечисление
          // именно для того, чтобы агенты различались.
          await ensureUnifiedAgentRun({
            id: agentRunId,
            caseId: job.caseId,
            agentName,
            actorId: job.requestedBy,
            prisma: deps.prisma ?? undefined,
          });
          const started = await startArsenkinCaseAgentDurable({
            caseId: job.caseId,
            agentRunId,
            agentId: agentName,
            tools,
            actorId: job.requestedBy,
            scheduleWorker: true,
            // Дозапуск автоматический: живое исполнение ждём, а не замещаем.
            // Иначе на здоровом прогоне агенты получают ARSENKIN_SUPERSEDED
            // на каждом обороте тика (шаг 15, I1).
            reuseActiveExecution: true,
            resolveBaseReportRunId: async () => baseId,
          });
          // Слияние, а не перезапись: прогоны уже отправленных агентов обязаны
          // пережить эту отправку, иначе их задачи потеряются.
          enrichmentRunIds = mergeAgentEnrichmentRunId(
            enrichmentRunIds,
            agentName,
            started.enrichmentReportRunId
          );
          warnings.push(`arsenkin-scheduled:${agentName}`);
        }
        return {
          enrichmentRunIds,
          arsenkinReportRunId: enrichmentRunIds[0] ?? null,
          warnings,
        };
      },
    });
  }

  const state: ArsenkinEnrichmentState = normalizeArsenkinEnrichmentState(tick.state, {
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
  });
  const enrichmentRunIds = tick.enrichmentRunIds;
  const planned = FIRST36_PLANNED_SUPPORTED_SURFACES.length;
  const coverage: SurfaceCoverageBreakdown = {
    ...emptyCoverage(planned),
    inFlight: state.pendingAgents.length,
    measured: state.enrichmentObservationCount > 0 ? Math.min(planned, state.completedAgents.length) : 0,
    noResults: state.agents.filter((a) => a.terminalKind === "EMPTY_VALID" || a.terminalKind === "NO_RESULTS")
      .length,
    failedRetryable: state.failedAgents.length,
    progressRatio: state.completedAgents.length / ARSENKIN_REAL_AGENT_NAMES.length,
  };

  await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "arsenkin-enrichment-state.json", state);
  // Keep job-scoped enrichment state even when failing closed (UI + exact resume).
  job =
    await patchUnifiedCollectionJob(job.caseId, {
      arsenkinEnrichmentState: state,
      enrichmentRunIds,
      arsenkinReportRunId: tick.arsenkinReportRunId,
    }) ?? job;

  if (tick.blockPipeline) {
    return await failRetryable(
      job,
      tick.blockCode ?? "ARSENKIN_ENRICHMENT_FAILED",
      tick.blockMessage ?? "Arsenkin enrichment failed",
      [...tick.warnings, "ARSENKIN_RESULT_INGEST"]
    );
  }

  if (tick.waiting || !state.enrichmentComplete) {
    // Persist partial observations + durable nextPollAt (restart-safe).
    const obsPath = await writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "arsenkin-enrichment-observations.json",
      {
        observations: tick.observations,
        arsenkinReportRunId: tick.arsenkinReportRunId,
        enrichmentRunIds,
        enrichmentComplete: false,
        state,
        ingestedResultHashes: state.ingestedResultHashes,
      }
    );
    // Прогресс обогащения выводится из строк задач и сверяется с хранимой
    // сводкой (шаг 12.4d). Пока это детектор: расхождение попадает в
    // предупреждения, поведение не меняется — так же поступили со стадией в
    // 12.4a, и это дало увидеть расхождение до того, как на него положились.
    const progressDrift = await detectStoredEnrichmentDrift(job, state, deps);
    // Бюджет ожидания считает опросы БЕЗ продвижения, а не все подряд: пока
    // задачи Arsenkin двигаются, ждать можно и нужно (шаг 14).
    const nowDate = deps.now?.() ?? new Date();
    const liveCounts = await countLiveEnrichmentProgress(job.caseId, deps);
    const currentMark = markEnrichmentProgress(state, liveCounts);
    const budget = decideEnrichmentPoll({
      previous: job.enrichmentProgressMark ?? null,
      current: currentMark,
      idlePolls: Number(job.pollAttempt ?? 0),
      waitStartedAt: job.enrichmentWaitStartedAt ?? null,
      now: nowDate,
    });
    if (budget.kind === "exhausted") {
      const fail = budget.retryable ? failRetryable : failTerminal;
      return await fail(
        job,
        "ARSENKIN_POLL_ATTEMPTS_EXCEEDED",
        budget.reason,
        ["ARSENKIN_RESULT_INGEST", `idlePolls:${budget.idlePolls}`]
      );
    }
    // Пауза растёт только при простое: продвижение — не повод ждать дольше.
    const nextPollAt =
      tick.nextPollAt ??
      new Date(nowDate.getTime() + pollBackoffMs(budget.idlePolls)).toISOString();
    return (
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "ARSENKIN_ENRICHMENT",
        status: "WAITING",
        progress: stageProgress("ARSENKIN_ENRICHMENT"),
        arsenkinReportRunId: tick.arsenkinReportRunId,
        enrichmentRunIds,
        arsenkinEnrichmentState: state,
        resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
        nextPollAt,
        // Тик, заблокированный внутренним синглтоном авторизации, до провайдера
        // не дошёл и о простое ничего не говорит — бюджет он не тратит (шаг 03).
        pollAttempt: isPollAuthContentionOnly(tick.warnings)
          ? Number(job.pollAttempt ?? 0)
          : budget.idlePolls,
        enrichmentProgressMark: currentMark,
        enrichmentWaitStartedAt:
          job.enrichmentWaitStartedAt ?? nowDate.toISOString(),
        coverage: { ...coverage, progressRatio: computeCoverageProgress(coverage) },
        warnings: [
          ...job.warnings,
          ...tick.warnings,
          ...progressDrift,
          "arsenkin-awaiting-ingest",
        ],
        artifactPaths: { ...job.artifactPaths, arsenkinObservations: obsPath },
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
      }) ?? job
    );
  }

  // Complete — invalidate stale downstream if prior composite/render existed, then advance.
  const priorComposite = job.compositeDatasetId;
  const priorLinks = job.reportLinks;
  const staleCompositeOnDisk = Boolean(
    await readUnifiedArtifact(job.caseId, job.unifiedJobId, "composite-serp-observations.json") ||
      await readUnifiedArtifact(job.caseId, job.unifiedJobId, "assembled-deck.json") ||
      await readUnifiedArtifact(job.caseId, job.unifiedJobId, "downstream-invalidation.json")
  );
  let invalidationWarnings: string[] = [];
  if (priorComposite || priorLinks?.pdf || priorLinks?.pptx || staleCompositeOnDisk) {
    const inv = await invalidateDownstreamAfterEnrichmentIngest({
      job,
      reason: "arsenkin-observations-ingested",
      previousCompositeDatasetId: priorComposite,
    });
    invalidationWarnings = inv.jobPatch.warnings ?? [];
  }

  const obsPath = await writeUnifiedArtifact(
    job.caseId,
    job.unifiedJobId,
    "arsenkin-enrichment-observations.json",
    {
      observations: tick.observations,
      arsenkinReportRunId: tick.arsenkinReportRunId,
      enrichmentRunIds,
      enrichmentComplete: true,
      state,
      ingestedResultHashes: state.ingestedResultHashes,
    }
  );

  return (
    await patchUnifiedCollectionJob(job.caseId, {
      stage: "COMPOSITE_MERGE",
      status: "RUNNING",
      progress: stageProgress("COMPOSITE_MERGE"),
      arsenkinReportRunId: tick.arsenkinReportRunId,
      enrichmentRunIds,
      arsenkinEnrichmentState: state,
      resumeCheckpoint: null,
      nextPollAt: null,
      pollAttempt: 0,
      coverage: { ...coverage, progressRatio: computeCoverageProgress(coverage) },
      warnings: [
        ...(invalidationWarnings.length > 0 ? invalidationWarnings : job.warnings),
        ...tick.warnings,
      ],
      artifactPaths: { ...job.artifactPaths, arsenkinObservations: obsPath },
      ...(priorComposite || priorLinks?.pdf || priorLinks?.pptx
        ? {
            compositeDatasetId: null as string | null,
            reportLinks: {} as { pdf?: string; pptx?: string; contactSheet?: string },
          }
        : {}),
    }) ?? job
  );
}

async function stepComposite(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const manifest = await readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  if (!manifest) {
    return (
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: "base-collection-manifest missing",
        lastErrorCode: "MANIFEST_MISSING",
        completedAt: new Date().toISOString(),
      }) ?? job
    );
  }

  const enrichment = await readUnifiedArtifact<{
    observations: Parameters<typeof mergeCompositeSerp>[0]["arsenkinObservations"];
    arsenkinReportRunId: string | null;
    enrichmentRunIds?: string[];
  }>(job.caseId, job.unifiedJobId, "arsenkin-enrichment-observations.json");

  const baseReportRunId = job.baseReportRunId ?? manifest.baseReportRunId;
  if (!baseReportRunId) {
    return await failRetryable(
      job,
      "BASE_REPORT_RUN_MISSING",
      "composite merge refused: baseReportRunId missing after base collection",
      ["composite-blocked:no-baseReportRunId"]
    );
  }

  let prisma: PrismaClient | null = deps.prisma ?? null;
  if (!prisma && !deps.fixtureBaseRows) {
    try {
      prisma = (await import("@/server/prisma/client")).prisma;
    } catch {
      prisma = null;
    }
  }

  const enrichmentComplete =
    Boolean(job.arsenkinEnrichmentState?.enrichmentComplete) ||
    Boolean((enrichment as { enrichmentComplete?: boolean } | null)?.enrichmentComplete);
  if (!enrichmentComplete) {
    return await failRetryable(
      job,
      "ARSENKIN_ENRICHMENT_INCOMPLETE",
      "composite refused: Arsenkin enrichmentComplete=false (schedule≠complete)",
      ["ARSENKIN_RESULT_INGEST", "composite-blocked:enrichment-incomplete"]
    );
  }

  const enrichmentRunIds =
    enrichment?.enrichmentRunIds && enrichment.enrichmentRunIds.length > 0
      ? enrichment.enrichmentRunIds
      : job.enrichmentRunIds && job.enrichmentRunIds.length > 0
        ? job.enrichmentRunIds
        : job.arsenkinReportRunId
          ? [job.arsenkinReportRunId]
          : [];

  const merge = await mergeCompositeSerp({
    prisma,
    manifest,
    enrichmentRunIds,
    arsenkinObservations: enrichment?.observations ?? [],
    fixtureBaseRows: deps.fixtureBaseRows,
  });

  if (merge.providerCounts.composite === 0 && manifest.baseCount > 0) {
    return await failRetryable(
      job,
      "COMPOSITE_BASE_EMPTY",
      "composite merge produced zero observations from a non-empty base manifest",
      ["composite-shrunk-base"]
    );
  }

  const coverageProbe = buildBaseObservationCoverage({ manifest, merge });
  await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "base-observation-coverage.json", coverageProbe);
  if (!coverageProbe.allBaseObservationsTraceable) {
    return await failRetryable(
      job,
      "BASE_OBSERVATION_COVERAGE_FAILED",
      `missing base ids: ${coverageProbe.missingBaseObservationIds.join(",")}`,
      ["composite-coverage-incomplete"]
    );
  }

  const binding = buildReportDataBinding({
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
    baseReportRunId,
    enrichmentRunIds,
    compositeDatasetId: merge.compositeDatasetId,
    providerCounts: merge.providerCounts,
  });

  // Persist the canonical subject identity into the job dir so the canonical
  // prepare is fully job-scoped. Order: injected (tests) → case-owned artifact
  // → automatic bootstrap from the case subject + the just-collected data.
  // Only when even the bootstrap cannot resolve a subject does prepare later
  // fail closed with SUBJECT_PROFILE_MISSING.
  let subjectProfile = await resolveJobSubjectProfile({
    caseId: job.caseId,
    injected: deps.subjectProfile ?? null,
  });
  if (!subjectProfile) {
    const bootstrap = await bootstrapSubjectProfileFromCollection({
      caseId: job.caseId,
      baseReportRunId,
      enrichmentRunId: enrichmentRunIds[0] ?? null,
      observations: merge.observations,
      subject: deps.caseSubject ?? null,
      prisma,
    });
    subjectProfile = bootstrap?.profile ?? null;
  }
  if (subjectProfile) {
    await writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "subject-identity-profile.json",
      subjectProfile
    );
  }

  const paths = {
    compositeObservations: await writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "composite-serp-observations.json",
      merge
    ),
    compositeProvenance: await writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "composite-serp-provenance.json",
      merge.provenance
    ),
    providerSurfaceCoverage: await writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "provider-surface-coverage.json",
      job.coverage
    ),
    reportDataBinding: await writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "report-data-binding.json",
      binding
    ),
    unifiedSummary: await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "unified-collection-summary.json", {
      unifiedJobId: job.unifiedJobId,
      stage: "COMPOSITE_MERGE",
      providerCounts: merge.providerCounts,
      coverage: job.coverage,
      actualProviders: job.actualProviders,
    }),
  };

  return (
    await patchUnifiedCollectionJob(job.caseId, {
      stage: "ORION_PREPARE",
      status: "RUNNING",
      progress: stageProgress("ORION_PREPARE"),
      compositeDatasetId: merge.compositeDatasetId,
      artifactPaths: { ...job.artifactPaths, ...paths },
    }) ?? job
  );
}

async function stepPrepare(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const manifest = await readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  const binding = await readUnifiedArtifact<ReportDataBinding>(
    job.caseId,
    job.unifiedJobId,
    "report-data-binding.json"
  );
  const merge = await readUnifiedArtifact<CompositeMergeResult>(
    job.caseId,
    job.unifiedJobId,
    "composite-serp-observations.json"
  );

  if (!binding || !merge || !manifest) {
    return (
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: "missing binding/merge/manifest before prepare",
        lastErrorCode: "PREPARE_INPUT_MISSING",
        completedAt: new Date().toISOString(),
      }) ?? job
    );
  }

  const resumeFromRender =
    job.resumeCheckpoint === "RENDER" || job.lastErrorCode === "RENDER_FAILED";
  const resumeFromGptCopy = job.resumeCheckpoint === "GPT_COPY";

  const enrichmentState =
    job.arsenkinEnrichmentState ??
    await readUnifiedArtifact<ArsenkinEnrichmentState>(
      job.caseId,
      job.unifiedJobId,
      "arsenkin-enrichment-state.json"
    );

  // PRE_RENDER_DATA_GATE — never call expensive HTTP render without data readiness.
  // RENDER / GPT_COPY resume already passed data gates; skip re-checking enrichment ingest.
  if (!resumeFromRender && !resumeFromGptCopy) {
    const preGate = assertPreRenderDataGates({
      binding,
      manifest,
      merge,
      enrichmentState,
      realCollectionSufficient: manifest.realCollectionSufficient,
      mockProviders: assessRealCollection(manifest.actualProviders).mockProviders,
      allowMockReport: deps.allowMockReport,
    });
    if (preGate.coverage) {
      await writeUnifiedArtifact(
        job.caseId,
        job.unifiedJobId,
        "base-observation-coverage.json",
        preGate.coverage
      );
    }
    if (!preGate.ok) {
      const errText = preGate.errors.join("; ");
      const ingestIncomplete = /enrichment/i.test(errText);
      // Терминальность решается фактом, а не сопоставлением строки: подмена
      // демо-данными повтором не лечится, и от формулировки сообщения это
      // зависеть не должно.
      const preAssessment = assessRealCollection(manifest.actualProviders);
      const dishonestBase = !deps.allowMockReport && !preAssessment.sufficient;
      if (dishonestBase) {
        return (
          await patchUnifiedCollectionJob(job.caseId, {
            stage: "FAILED_TERMINAL",
            status: "FAILED",
            lastError: errText,
            lastErrorCode: preGate.code,
            completedAt: new Date().toISOString(),
            warnings: [...job.warnings, "PRE_RENDER_DATA_GATE_FAILED", "NO_RENDER_BEFORE_DATA_GATE"],
          }) ?? job
        );
      }
      return await failRetryable(job, "PRE_RENDER_DATA_GATE_FAILED", errText, [
        ingestIncomplete ? "ARSENKIN_RESULT_INGEST" : "PRE_RENDER_DATA_GATE",
        "NO_RENDER_BEFORE_DATA_GATE",
        "HTTP_RENDER_CALLS_ON_FAILED_GATE_ZERO",
      ]);
    }
  }

  // Prefer injected deps.prisma; fall back to the server client so rebuild/tick
  // without explicit deps still loads WikipediaCheck / SerpCapture / profiles.
  let preparePrisma: PrismaClient | null = deps.prisma ?? null;
  if (!preparePrisma) {
    try {
      preparePrisma = (await import("@/server/prisma/client")).prisma;
    } catch {
      preparePrisma = null;
    }
  }

  // Default = canonical job-scoped pipeline. There is NO legacy composer path:
  // a disabled/blocked canonical prepare fails closed and never falls back.
  const runPrepare =
    deps.runPrepare ??
    (async ({ caseId, binding: b, merge: m }) => {
      const res = await runCanonicalReportPrepare({
        caseId,
        unifiedJobId: job.unifiedJobId,
        artifactsDir: unifiedArtifactsDir(caseId, job.unifiedJobId),
        binding: b,
        merge: m,
        subjectProfile: deps.subjectProfile ?? null,
        render: deps.renderDeck,
        resumeFrom: resumeFromGptCopy
          ? "gpt-copy"
          : resumeFromRender
            ? "render"
            : "full",
        prisma: preparePrisma
          ? {
              searchResult: preparePrisma.searchResult,
              searchSurfaceItem: preparePrisma.searchSurfaceItem,
              databaseProfile: preparePrisma.databaseProfile,
              riskFinding: preparePrisma.riskFinding,
              wikipediaCheck: preparePrisma.wikipediaCheck,
              serpCapture: preparePrisma.serpCapture,
            }
          : null,
      });
      return {
        prepareDatasetId: res.prepareDatasetId,
        pdf: res.pdf,
        pptx: res.pptx,
        contactSheet: res.contactSheet,
        assemblyCount: res.assemblyCount,
        renderCount: res.renderCount,
        reportQuality: res.reportQuality ?? null,
        qualityWarnings: res.qualityWarnings ?? [],
      };
    });

  let prepared: Awaited<ReturnType<typeof runPrepare>>;
  try {
    prepared = await runPrepare({ caseId: job.caseId, binding, merge });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof CanonicalPrepareBlockedError ? err.code : "CANONICAL_PREPARE_FAILED";
    /*
     * Провал прогона называется вслух, в логе.
     *
     * Отказ записывался в саму джобу и виден был только в интерфейсе. В логе
     * при этом не появлялось ни строки: подборщик каждые пять секунд печатал
     * «подобрано прогонов: 1», и упавший прогон выглядел точно так же, как
     * идущий. Кейс DPA-2026-0031 простоял так больше получаса.
     *
     * Сообщение обрезано: разбор схемы приносит абзац JSON, а в логе нужен
     * признак, по которому видно, куда смотреть.
     */
    console.error(
      `[unified] прогон остановлен: кейс=${job.caseId} джоба=${job.unifiedJobId} ` +
        `стадия=${job.stage} код=${code} — ${message.replace(/\s+/gu, " ").slice(0, 300)}`
    );
    const enrichmentObs = await readUnifiedArtifact<{ enrichmentRunIds?: string[] }>(
      job.caseId,
      job.unifiedJobId,
      "arsenkin-enrichment-observations.json"
    );
    const enrichmentIds =
      enrichmentObs?.enrichmentRunIds ?? job.enrichmentRunIds ?? [];
    const linkageIncomplete =
      job.warnings.some((w) =>
        /arsenkin-blocked|arsenkin-skipped:no-base|ARSENKIN_STAGE_NOT_STARTED|BASE_REPORT_RUN/i.test(w)
      ) ||
      (enrichmentIds.length === 0 && String(process.env.NETWORK_CALLS ?? "") !== "0");
    const isAssemblyFailure =
      code === "ASSEMBLY_FAILED" ||
      code === "REQUIRED_SECTION_FAILED" ||
      // Испорченный текст сборки чинится пересборкой: данные сбора целы.
      code === "ASSEMBLY_QA_FAILED" ||
      /required sections failed/i.test(message);
    const assemblySparse = isAssemblyFailure && linkageIncomplete;

    if (code === "RENDER_FAILED") {
      return await failRetryable(job, "RENDER_FAILED", message, [
        "render-checkpoint:RENDER",
        "CANONICAL_PREPARE_BLOCKED",
      ]);
    }

    // Assembly/section QA failures are retryable when collection data is intact
    // (live §3.2 regression: uncategorized refs → RU/UAE SUMMARY FAILED).
    if (isAssemblyFailure && !linkageIncomplete) {
      return await failRetryable(job, code, message, [
        "CANONICAL_PREPARE_BLOCKED",
        "retryable-assembly-failure",
      ]);
    }

    if (linkageIncomplete || assemblySparse) {
      return await failRetryable(
        job,
        assemblySparse ? "ASSEMBLY_INCOMPLETE_ENRICHMENT" : code,
        message,
        ["CANONICAL_PREPARE_BLOCKED", "retryable-linkage-failure"]
      );
    }

    const restored = await restoreAfterFailedRebuild(job, code, message);
    if (restored) return restored;

    return (
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        // Гейт называет себя кодом («MATERIAL_THEME_COVERAGE=87.5»), по которому
        // оператор не может действовать. Сообщение объясняет, что произошло и
        // что делать, а код сохраняется для диагностики (шаг 15, E1).
        lastError: prepareGateFailureMessage(message),
        lastErrorCode: code,
        completedAt: new Date().toISOString(),
        warnings: [...job.warnings, "CANONICAL_PREPARE_BLOCKED"],
      }) ?? job
    );
  }

  // Full / gpt-copy prepare: exactly one assembly. Render-resume: assembly may be 0 (reused).
  // Always exactly one render per successful prepare.
  const assemblyOk =
    prepared.assemblyCount == null ||
    prepared.assemblyCount === 1 ||
    (resumeFromRender && !resumeFromGptCopy && prepared.assemblyCount === 0);
  if (!assemblyOk || (prepared.renderCount != null && prepared.renderCount !== 1)) {
    return (
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: `expected valid assembly/render counts, got assembly=${prepared.assemblyCount} render=${prepared.renderCount}`,
        lastErrorCode: "ASSEMBLY_RENDER_COUNT_INVALID",
        completedAt: new Date().toISOString(),
      }) ?? job
    );
  }

  const baseAssessment = assessRealCollection(manifest.actualProviders);

  const gate = assertReportReadyGates({
    binding,
    manifest,
    merge,
    prepareDatasetId: prepared.prepareDatasetId,
    clientContentDatasetId: prepared.prepareDatasetId,
    realCollectionSufficient: manifest.realCollectionSufficient,
    mockProviders: baseAssessment.mockProviders,
    allowMockReport: deps.allowMockReport,
    coverage: job.coverage,
    skipBaseCoverage: resumeFromRender || resumeFromGptCopy,
    requireAiReport: digitalProfileConfig.requireAiReport,
    gptLayerApplied: gptLayerAppliedFromQuality(prepared.reportQuality),
  });

  if (!gate.ok) {
    return (
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: gate.errors.join("; "),
        lastErrorCode: gate.code,
        completedAt: new Date().toISOString(),
        warnings: [...job.warnings, "REPORT_READY_GATE_FAILED"],
      }) ?? job
    );
  }

  // Do not treat historical `arsenkin-failed:*` warnings as live failures once
  // enrichment completed with zero failedAgents (stale warnings sticky otherwise).
  const liveArsenkinFailed =
    (job.arsenkinEnrichmentState?.failedAgents?.length ?? 0) > 0 ||
    (!job.arsenkinEnrichmentState?.enrichmentComplete &&
      job.warnings.some((w) => /arsenkin-failed/i.test(w)));
  // Отказ одного из живых провайдеров — неполнота, а не повод выбросить прогон:
  // именно для этого и существует COMPLETED_PARTIAL (шаг 13, B1).
  const partial =
    (job.coverage?.failedFinal ?? 0) > 0 ||
    liveArsenkinFailed ||
    baseAssessment.failedProviders.length > 0 ||
    job.warnings.some((w) => /arsenkin-skipped|visual-asset-partial-failures/i.test(w));

  // Persist funnel summary on the job (REMEDIATION §0.1). Prefer the value
  // returned by prepare; otherwise rebuild from the job artifact directory.
  let reportQuality = prepared.reportQuality ?? null;
  let qualityWarnings = [...(prepared.qualityWarnings ?? [])];
  try {
    if (!reportQuality) {
      const summary = await buildReportQualitySummary({
        jobDir: unifiedArtifactsDir(job.caseId, job.unifiedJobId),
        caseId: job.caseId,
        unifiedJobId: job.unifiedJobId,
        prisma: deps.prisma
          ? {
              searchResult: deps.prisma.searchResult,
              searchSurfaceItem: deps.prisma.searchSurfaceItem,
            }
          : null,
      });
      reportQuality = toJobReportQuality(summary);
      await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "report-quality-summary.json", summary);
      if (qualityWarnings.length === 0) {
        qualityWarnings = buildReportQualityWarnings(summary);
      }
    } else {
      // Ensure the full artifact is present even when prepare already wrote it
      // (idempotent overwrite from the same source of truth).
      const existing = await readUnifiedArtifact(job.caseId, job.unifiedJobId, "report-quality-summary.json");
      if (!existing) {
        const summary = await buildReportQualitySummary({
          jobDir: unifiedArtifactsDir(job.caseId, job.unifiedJobId),
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
        });
        await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "report-quality-summary.json", summary);
        reportQuality = toJobReportQuality(summary);
        if (qualityWarnings.length === 0) {
          qualityWarnings = buildReportQualityWarnings(summary);
        }
      }
    }
  } catch {
    // Observability must never block REPORT_READY.
  }

  const warningsForReady = mergeJobWarnings(job.warnings, qualityWarnings).filter((w) => {
    // Drop sticky historical Arsenkin failures once enrichment is clean.
    if (
      /arsenkin-failed:/i.test(w) &&
      job.arsenkinEnrichmentState?.enrichmentComplete &&
      (job.arsenkinEnrichmentState.failedAgents?.length ?? 0) === 0
    ) {
      return false;
    }
    // The rebuild attempt is over — drop its marker so a later, unrelated
    // failure cannot restore this run's stale snapshot.
    if (w === REBUILD_MARKER) return false;
    return true;
  });

  return (
    await patchUnifiedCollectionJob(job.caseId, {
      stage: partial ? "COMPLETED_PARTIAL" : "REPORT_READY",
      // Полнота результата записывается отдельно от места в конвейере, чтобы
      // стадию можно было вывести из шагов, ничего не потеряв (шаг 12.4b).
      completeness: partial ? "partial" : "full",
      status: "COMPLETED",
      progress: 1,
      completedAt: new Date().toISOString(),
      // Ошибка неудавшейся попытки при успехе снимается. Иначе на готовом
      // отчёте в шапке висит код прошлого отказа, и оператор читает
      // завершённый прогон как сломанный (шаг 15, живой прогон).
      lastError: null,
      lastErrorCode: null,
      reportLinks: {
        pdf: prepared.pdf,
        pptx: prepared.pptx,
        ...(prepared.contactSheet ? { contactSheet: prepared.contactSheet } : {}),
      },
      warnings: warningsForReady,
      ...(reportQuality ? { reportQuality } : {}),
    }) ?? job
  );
}

export async function getUnifiedCollectionStatus(caseId: string): Promise<UnifiedCollectionJob | null> {
  return await loadUnifiedCollectionJob(caseId);
}
