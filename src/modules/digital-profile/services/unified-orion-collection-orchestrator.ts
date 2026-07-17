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
import { assertReportReadyGates } from "./report-ready-gates";
import {
  runCanonicalReportPrepare,
  CanonicalPrepareBlockedError,
} from "./canonical-report-prepare";
import type { DeckRenderAdapter } from "./render-deck-artifacts";
import { resolveJobSubjectProfile } from "./job-subject-profile";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import type { FullAuditResultDTO } from "./agent-run-service";

export type UnifiedOrchestratorDeps = {
  prisma?: PrismaClient | null;
  runFullAudit?: (caseId: string, actorId: string) => Promise<FullAuditResultDTO>;
  /** Offline Arsenkin enrichment: returns coverage + optional observations. */
  runArsenkinEnrichment?: (job: UnifiedCollectionJob) => Promise<{
    arsenkinReportRunId: string | null;
    coverage: SurfaceCoverageBreakdown;
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
    }>;
    warnings?: string[];
    partial?: boolean;
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
    assemblyCount?: number;
    renderCount?: number;
  }>;
  /** Subject identity for canonical prepare (production resolves from the case). */
  subjectProfile?: ClassifierSubjectProfile | null;
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

export async function startUnifiedOrionCollection(input: {
  caseId: string;
  requestedBy?: string;
  arsenkinMode?: "full-first36";
  deps?: UnifiedOrchestratorDeps;
}): Promise<{ accepted: true; jobId: string; unifiedJobId: string; created: boolean; stage: string }> {
  const { job, created } = findOrCreateUnifiedCollectionJob({
    caseId: input.caseId,
    requestedBy: input.requestedBy ?? "system",
    arsenkinMode: input.arsenkinMode ?? "full-first36",
  });
  if (input.deps?.autoSchedule !== false) {
    scheduleUnifiedTick(input.caseId, input.deps);
  }
  return {
    accepted: true,
    jobId: job.jobId,
    unifiedJobId: job.unifiedJobId,
    created,
    stage: job.stage,
  };
}

const ticking = new Set<string>();

export function scheduleUnifiedTick(caseId: string, deps: UnifiedOrchestratorDeps = {}): void {
  if (ticking.has(caseId)) return;
  ticking.add(caseId);
  setImmediate(() => {
    void runUnifiedCollectionTick(caseId, deps)
      .catch(() => undefined)
      .finally(() => {
        ticking.delete(caseId);
        const job = loadUnifiedCollectionJob(caseId);
        if (
          job &&
          job.status === "RUNNING" &&
          job.stage !== "REPORT_READY" &&
          job.stage !== "COMPLETED_PARTIAL" &&
          job.stage !== "FAILED_TERMINAL" &&
          job.stage !== "CANCELLED"
        ) {
          setTimeout(() => scheduleUnifiedTick(caseId, deps), 50);
        }
      });
  });
}

/** Bounded resume after deploy — only active/retryable jobs. */
export function resumeUnifiedCollectionsOnStartup(deps: UnifiedOrchestratorDeps = {}): void {
  for (const { caseId } of listResumableUnifiedJobs()) {
    scheduleUnifiedTick(caseId, deps);
  }
}

export async function runUnifiedCollectionTick(
  caseId: string,
  deps: UnifiedOrchestratorDeps = {}
): Promise<UnifiedCollectionJob | null> {
  const ownerId = `unified-${process.pid}-${randomUUID().slice(0, 6)}`;
  const claimed = claimUnifiedJobLease({ caseId, ownerId, leaseMs: 120_000, now: deps.now?.() });
  if (!claimed) return loadUnifiedCollectionJob(caseId);

  try {
    let job = claimed;
    if (job.cancelRequested) {
      return patchUnifiedCollectionJob(caseId, {
        stage: "CANCELLED",
        status: "CANCELLED",
        completedAt: new Date().toISOString(),
      });
    }

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
        job =
          patchUnifiedCollectionJob(caseId, {
            stage: "BASE_COLLECTION",
            status: "RUNNING",
            lastError: null,
            warnings: [...job.warnings, "bounded-resume"],
          }) ?? job;
        break;
      default:
        break;
    }
    return loadUnifiedCollectionJob(caseId);
  } finally {
    releaseUnifiedJobLease(caseId, ownerId);
  }
}

async function stepBaseCollection(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const runFullAudit =
    deps.runFullAudit ??
    (async (caseId: string, actorId: string) => {
      const { runFullAudit: real } = await import("./agent-run-service");
      return real(caseId, { actorId });
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
    });
  } else {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: "prisma unavailable for base-collection-manifest",
        lastErrorCode: "MANIFEST_CAPTURE_FAILED",
        completedAt: new Date().toISOString(),
      }) ?? job
    );
  }

  const path = writeUnifiedArtifact(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json",
    manifest
  );

  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: "ARSENKIN_ENRICHMENT",
      status: "RUNNING",
      progress: stageProgress("ARSENKIN_ENRICHMENT"),
      actualProviders,
      baseReportRunId: manifest.baseReportRunId,
      artifactPaths: { ...job.artifactPaths, baseCollectionManifest: path },
      warnings: manifest.realCollectionSufficient
        ? job.warnings
        : [...job.warnings, "base-collection used mock/fallback — REPORT_READY blocked unless allowMockReport"],
    }) ?? job
  );
}

async function stepArsenkin(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const runEnrichment =
    deps.runArsenkinEnrichment ??
    (async () => {
      // Default offline-safe stub: mark all planned surfaces NOT_SUPPORTED when NETWORK_CALLS=0
      // or when no client — production wires startArsenkinFullAudit separately.
      const networkOff = String(process.env.NETWORK_CALLS ?? "") === "0";
      const planned = FIRST36_PLANNED_SUPPORTED_SURFACES.length;
      if (networkOff) {
        return {
          arsenkinReportRunId: null,
          coverage: {
            ...emptyCoverage(planned),
            notSupported: planned,
            progressRatio: 1,
          },
          observations: [],
          warnings: ["arsenkin-skipped:NETWORK_CALLS=0"],
          partial: true,
        };
      }
      // Live path: start existing Full audit without swapping effectiveReportRunId
      try {
        const baseId = job.baseReportRunId;
        if (!baseId) {
          return {
            arsenkinReportRunId: null,
            coverage: {
              ...emptyCoverage(planned),
              notSupported: planned,
              progressRatio: 1,
            },
            observations: [],
            warnings: ["arsenkin-skipped:no-baseReportRunId"],
            partial: true,
          };
        }
        const { startArsenkinFullAudit } = await import("../providers/arsenkin/full-audit-orchestrator");
        const started = await startArsenkinFullAudit({
          caseId: job.caseId,
          reportRunId: baseId,
          actorId: job.requestedBy,
          confirmed: true,
          requestedWorkflowType: "FIRST36_FULL",
        });
        return {
          arsenkinReportRunId: started.reportRunId,
          coverage: emptyCoverage(planned),
          observations: [],
          warnings: ["arsenkin-full-started"],
          partial: true,
        };
      } catch (err) {
        return {
          arsenkinReportRunId: null,
          coverage: {
            ...emptyCoverage(planned),
            failedFinal: planned,
            progressRatio: 1,
          },
          observations: [],
          warnings: [`arsenkin-failed:${err instanceof Error ? err.message : String(err)}`],
          partial: true,
        };
      }
    });

  const result = await runEnrichment(job);
  const coverage = {
    ...result.coverage,
    progressRatio: computeCoverageProgress(result.coverage),
  };
  const obsPath = writeUnifiedArtifact(job.caseId, job.unifiedJobId, "arsenkin-enrichment-observations.json", {
    observations: result.observations,
    arsenkinReportRunId: result.arsenkinReportRunId,
  });

  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: "COMPOSITE_MERGE",
      status: "RUNNING",
      progress: stageProgress("COMPOSITE_MERGE"),
      arsenkinReportRunId: result.arsenkinReportRunId,
      coverage,
      warnings: [...job.warnings, ...(result.warnings ?? [])],
      artifactPaths: { ...job.artifactPaths, arsenkinObservations: obsPath },
    }) ?? job
  );
}

async function stepComposite(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const manifest = readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  if (!manifest) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: "base-collection-manifest missing",
        lastErrorCode: "MANIFEST_MISSING",
        completedAt: new Date().toISOString(),
      }) ?? job
    );
  }

  const enrichment = readUnifiedArtifact<{
    observations: Parameters<typeof mergeCompositeSerp>[0]["arsenkinObservations"];
    arsenkinReportRunId: string | null;
  }>(job.caseId, job.unifiedJobId, "arsenkin-enrichment-observations.json");

  let prisma: PrismaClient | null = deps.prisma ?? null;
  if (!prisma && !deps.fixtureBaseRows) {
    try {
      prisma = (await import("@/server/prisma/client")).prisma;
    } catch {
      prisma = null;
    }
  }

  const merge = await mergeCompositeSerp({
    prisma,
    manifest,
    enrichmentRunIds: job.arsenkinReportRunId ? [job.arsenkinReportRunId] : [],
    arsenkinObservations: enrichment?.observations ?? [],
    fixtureBaseRows: deps.fixtureBaseRows,
  });

  const binding = buildReportDataBinding({
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
    baseReportRunId: job.baseReportRunId ?? manifest.baseReportRunId,
    enrichmentRunIds: job.arsenkinReportRunId ? [job.arsenkinReportRunId] : [],
    compositeDatasetId: merge.compositeDatasetId,
    providerCounts: merge.providerCounts,
  });

  // Persist the canonical subject identity into the job dir so the canonical
  // prepare is fully job-scoped. Injected (tests) or case-owned only — never a
  // baseline default. Absence is allowed here; prepare fails closed later.
  const subjectProfile = await resolveJobSubjectProfile({
    caseId: job.caseId,
    injected: deps.subjectProfile ?? null,
  });
  if (subjectProfile) {
    writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "subject-identity-profile.json",
      subjectProfile
    );
  }

  const paths = {
    compositeObservations: writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "composite-serp-observations.json",
      merge
    ),
    compositeProvenance: writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "composite-serp-provenance.json",
      merge.provenance
    ),
    providerSurfaceCoverage: writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "provider-surface-coverage.json",
      job.coverage
    ),
    reportDataBinding: writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "report-data-binding.json",
      binding
    ),
    unifiedSummary: writeUnifiedArtifact(job.caseId, job.unifiedJobId, "unified-collection-summary.json", {
      unifiedJobId: job.unifiedJobId,
      stage: "COMPOSITE_MERGE",
      providerCounts: merge.providerCounts,
      coverage: job.coverage,
      actualProviders: job.actualProviders,
    }),
  };

  return (
    patchUnifiedCollectionJob(job.caseId, {
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
  const manifest = readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  const binding = readUnifiedArtifact<ReportDataBinding>(
    job.caseId,
    job.unifiedJobId,
    "report-data-binding.json"
  );
  const merge = readUnifiedArtifact<CompositeMergeResult>(
    job.caseId,
    job.unifiedJobId,
    "composite-serp-observations.json"
  );

  if (!binding || !merge || !manifest) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: "missing binding/merge/manifest before prepare",
        lastErrorCode: "PREPARE_INPUT_MISSING",
        completedAt: new Date().toISOString(),
      }) ?? job
    );
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
      });
      return {
        prepareDatasetId: res.prepareDatasetId,
        pdf: res.pdf,
        pptx: res.pptx,
        assemblyCount: res.assemblyCount,
        renderCount: res.renderCount,
      };
    });

  let prepared: Awaited<ReturnType<typeof runPrepare>>;
  try {
    prepared = await runPrepare({ caseId: job.caseId, binding, merge });
  } catch (err) {
    const code =
      err instanceof CanonicalPrepareBlockedError ? err.code : "CANONICAL_PREPARE_FAILED";
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: err instanceof Error ? err.message : String(err),
        lastErrorCode: code,
        completedAt: new Date().toISOString(),
        warnings: [...job.warnings, "CANONICAL_PREPARE_BLOCKED"],
      }) ?? job
    );
  }

  // Assert exactly one assembly and one render per completed job (fail-closed).
  if (
    (prepared.assemblyCount != null && prepared.assemblyCount !== 1) ||
    (prepared.renderCount != null && prepared.renderCount !== 1)
  ) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: `expected exactly one assembly and one render, got assembly=${prepared.assemblyCount} render=${prepared.renderCount}`,
        lastErrorCode: "ASSEMBLY_RENDER_COUNT_INVALID",
        completedAt: new Date().toISOString(),
      }) ?? job
    );
  }

  const gate = assertReportReadyGates({
    binding,
    manifest,
    merge,
    prepareDatasetId: prepared.prepareDatasetId,
    clientContentDatasetId: prepared.prepareDatasetId,
    realCollectionSufficient: manifest.realCollectionSufficient,
    allowMockReport: deps.allowMockReport,
    coverage: job.coverage,
  });

  if (!gate.ok) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: gate.errors.join("; "),
        lastErrorCode: gate.code,
        completedAt: new Date().toISOString(),
        warnings: [...job.warnings, "REPORT_READY_GATE_FAILED"],
      }) ?? job
    );
  }

  const partial =
    (job.coverage?.failedFinal ?? 0) > 0 ||
    job.warnings.some((w) => /arsenkin-failed|arsenkin-skipped|partial/i.test(w));

  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: partial ? "COMPLETED_PARTIAL" : "REPORT_READY",
      status: "COMPLETED",
      progress: 1,
      completedAt: new Date().toISOString(),
      reportLinks: { pdf: prepared.pdf, pptx: prepared.pptx },
    }) ?? job
  );
}

export function getUnifiedCollectionStatus(caseId: string): UnifiedCollectionJob | null {
  return loadUnifiedCollectionJob(caseId);
}
