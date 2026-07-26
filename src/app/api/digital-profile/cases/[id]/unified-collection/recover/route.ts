/**
 * POST /api/digital-profile/cases/[id]/unified-collection/recover
 * Staff recovery: rebind baseReportRunId from existing base manifest and resume
 * at ARSENKIN_ENRICHMENT. Never starts a new job or base provider collection.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule, ValidationError } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { digitalProfileConfig } from "@/modules/digital-profile/config";
import { recoverUnifiedOrionCollectionJob } from "@/modules/digital-profile/services/unified-collection-recovery";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "agents.run");
  if (!digitalProfileConfig.mockAgents) requireRole(user, "agents.runReal");
  await requireCaseAccess(user, id, "VIEWER");

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const jobId = String(body.jobId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");

  const actor = actorOf(user);
  const data = await recoverUnifiedOrionCollectionJob({
    caseId: id,
    jobId,
    actorId: actor.actorId ?? user.id,
  });
  return jsonOk(data, 202);
});
