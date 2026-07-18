/**
 * /api/digital-profile/cases/[id]/unified-collection
 *   POST — start (idempotent) unified ORION + Arsenkin collection job
 *   GET  — job status
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { digitalProfileConfig } from "@/modules/digital-profile/config";
import {
  getUnifiedCollectionStatus,
  startUnifiedOrionCollection,
  unifiedJobHasPreservedStages,
} from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { withUnifiedRecoveryStatusFields } from "@/modules/digital-profile/services/unified-collection-recovery";
import { evaluateUnifiedReportRebuildEligibility } from "@/modules/digital-profile/services/unified-report-rebuild";
import { withSuggestionsGapStatus } from "@/modules/digital-profile/services/unified-suggestions-gap";
import { getCanonicalDownloadAvailability } from "@/modules/digital-profile/services/canonical-report-artifacts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "agents.run");
  if (!digitalProfileConfig.mockAgents) requireRole(user, "agents.runReal");
  await requireCaseAccess(user, id, "VIEWER");
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const actor = actorOf(user);
  const data = await startUnifiedOrionCollection({
    caseId: id,
    requestedBy: actor.actorId ?? user.id,
    arsenkinMode: "full-first36",
    confirmPaidRecollection: body?.confirmPaidRecollection === true,
  });
  return jsonOk(data, 202);
});

async function loadSuggestTasksForGap(
  enrichmentRunId: string | null
): Promise<
  Array<{
    state: string;
    toolName: string | null;
    externalTaskId: string | null;
    errorCode: string | null;
  }> | undefined
> {
  if (!enrichmentRunId) return undefined;
  try {
    const { prisma } = await import("@/server/prisma/client");
    const rows = await prisma.providerTask.findMany({
      where: { reportRunId: enrichmentRunId },
      select: {
        state: true,
        toolName: true,
        externalTaskId: true,
        errorCode: true,
      },
      take: 50,
    });
    return rows.map((r) => ({
      state: String(r.state),
      toolName: r.toolName,
      externalTaskId: r.externalTaskId,
      errorCode: r.errorCode,
    }));
  } catch {
    return undefined;
  }
}

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  await requireCaseAccess(user, id, "VIEWER");
  const job = getUnifiedCollectionStatus(id);
  const recovery = withUnifiedRecoveryStatusFields(job);
  const suggestionsRunId =
    (job?.enrichmentRunIds ?? []).find((rid) => /suggestions/i.test(rid)) ?? null;
  const suggestTasks = await loadSuggestTasksForGap(suggestionsRunId);
  const suggestionsGap = withSuggestionsGapStatus(job, suggestTasks);
  const preserved = unifiedJobHasPreservedStages(job);
  const fullAuditBlocked =
    Boolean(job) &&
    (Boolean(recovery.recoveryAllowed) ||
      suggestionsGap.suggestionsMissingResult ||
      preserved ||
      job?.status === "RUNNING" ||
      job?.status === "WAITING");
  const downloadArtifacts =
    job && job.stage === "REPORT_READY" && job.status === "COMPLETED"
      ? getCanonicalDownloadAvailability({ caseId: id, jobId: job.unifiedJobId })
      : { pdf: false, pptx: false, contactSheet: false };
  const rebuild = evaluateUnifiedReportRebuildEligibility({ caseId: id, job });
  return jsonOk({
    job: job
      ? {
          jobId: job.jobId,
          unifiedJobId: job.unifiedJobId,
          stage: job.stage,
          status: job.status,
          progress: job.progress,
          actualProviders: job.actualProviders,
          coverage: job.coverage,
          warnings: job.warnings,
          lastError: job.lastError,
          lastErrorCode: job.lastErrorCode,
          baseReportRunId: job.baseReportRunId,
          arsenkinReportRunId: job.arsenkinReportRunId,
          enrichmentRunIds: job.enrichmentRunIds ?? [],
          compositeDatasetId: job.compositeDatasetId,
          reportLinks: job.reportLinks,
          downloadArtifacts,
          artifactPaths: job.artifactPaths,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          completedAt: job.completedAt,
          arsenkinEnrichmentState: job.arsenkinEnrichmentState
            ? {
                scheduledAgents: job.arsenkinEnrichmentState.scheduledAgents,
                completedAgents: job.arsenkinEnrichmentState.completedAgents,
                failedAgents: job.arsenkinEnrichmentState.failedAgents,
                pendingAgents: job.arsenkinEnrichmentState.pendingAgents,
                ingestedAgents: job.arsenkinEnrichmentState.ingestedAgents,
                enrichmentObservationCount:
                  job.arsenkinEnrichmentState.enrichmentObservationCount,
                enrichmentComplete: job.arsenkinEnrichmentState.enrichmentComplete,
              }
            : null,
          recoveryAllowed: recovery.recoveryAllowed,
          recoveryBlockerReason: recovery.recoveryBlockerReason,
          recoveryReason: recovery.recoveryReason,
          rebuildAllowed: rebuild.rebuildAllowed,
          rebuildBlockerReason: rebuild.rebuildBlockerReason,
          recoveryAudit: job.recoveryAudit ?? null,
          resumeCheckpoint: job.resumeCheckpoint ?? null,
          nextPollAt: job.nextPollAt ?? null,
          pollAttempt: job.pollAttempt ?? 0,
          ...suggestionsGap,
          fullAuditBlocked,
          fullAuditBlockReason: fullAuditBlocked
            ? suggestionsGap.suggestionsMissingResult
              ? "USE_SUGGESTIONS_TARGETED_RETRY"
              : recovery.recoveryAllowed
                ? "USE_RECOVERY"
                : preserved
                  ? "PRESERVED_STAGES_REQUIRE_PAID_RECOLLECTION"
                  : "JOB_ACTIVE"
            : null,
          paidRecollectionRequired: preserved && !recovery.recoveryAllowed,
        }
      : null,
  });
});
