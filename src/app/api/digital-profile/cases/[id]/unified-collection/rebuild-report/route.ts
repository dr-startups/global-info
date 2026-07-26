/**
 * POST /api/digital-profile/cases/[id]/unified-collection/rebuild-report
 * Explicit report rebuild for a COMPLETED unified job: re-run analytics →
 * assembly → render from the persisted composite dataset (same jobId).
 * Never starts base collection and never creates Arsenkin submissions.
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
import { rebuildUnifiedReport } from "@/modules/digital-profile/services/unified-report-rebuild";

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
  const data = await rebuildUnifiedReport({
    caseId: id,
    jobId,
    actorId: actor.actorId ?? user.id,
  });
  return jsonOk(data, 202);
});
