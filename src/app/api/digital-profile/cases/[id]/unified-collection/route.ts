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

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  await requireCaseAccess(user, id, "VIEWER");
  const job = getUnifiedCollectionStatus(id);
  const recovery = withUnifiedRecoveryStatusFields(job);
  const preserved = unifiedJobHasPreservedStages(job);
  const fullAuditBlocked =
    Boolean(job) &&
    (Boolean(recovery.recoveryAllowed) ||
      preserved ||
      job?.status === "RUNNING" ||
      job?.status === "WAITING");
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
          recoveryAudit: job.recoveryAudit ?? null,
          resumeCheckpoint: job.resumeCheckpoint ?? null,
          fullAuditBlocked,
          fullAuditBlockReason: fullAuditBlocked
            ? recovery.recoveryAllowed
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
