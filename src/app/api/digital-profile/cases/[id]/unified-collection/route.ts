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
  });
  void body;
  return jsonOk(data, 202);
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  await requireCaseAccess(user, id, "VIEWER");
  const job = getUnifiedCollectionStatus(id);
  const recovery = withUnifiedRecoveryStatusFields(job);
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
          recoveryAllowed: recovery.recoveryAllowed,
          recoveryBlockerReason: recovery.recoveryBlockerReason,
          recoveryReason: recovery.recoveryReason,
          recoveryAudit: job.recoveryAudit ?? null,
          resumeCheckpoint: job.resumeCheckpoint ?? null,
        }
      : null,
  });
});
