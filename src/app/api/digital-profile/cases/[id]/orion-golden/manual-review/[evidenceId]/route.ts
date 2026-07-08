/**
 * GET /api/digital-profile/cases/[id]/orion-golden/manual-review/[evidenceId]
 * POST — submit admin review decision (artifact-backed)
 */

import type { NextRequest } from "next/server";
import { z } from "zod";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import {
  getManualReviewItem,
  submitAdminReviewDecision,
} from "@/modules/digital-profile/orion-golden/services/admin-review-workflow-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; evidenceId: string }> };

const SubmitDecisionSchema = z.object({
  status: z.enum([
    "PENDING",
    "APPROVED",
    "APPROVED_WITH_CAVEAT",
    "APPENDIX_ONLY",
    "EXCLUDED",
    "NEEDS_MORE_SOURCES",
    "WRONG_SUBJECT",
  ]),
  reviewerNote: z.string().optional(),
  approvedClientSummary: z.string().optional(),
  caveatText: z.string().optional(),
  requestedSources: z.array(z.string()).optional(),
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id, evidenceId } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");
  const data = getManualReviewItem(id, evidenceId);
  return jsonOk(data);
});

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id, evidenceId } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "risk.review");
  await requireCaseAccess(user, id, "REVIEWER");
  const input = SubmitDecisionSchema.parse(await readJsonBody(req));
  const actor = actorOf(user);
  const data = submitAdminReviewDecision(id, evidenceId, {
    ...input,
    reviewedBy: actor.actorId ?? undefined,
    reviewedAt: new Date().toISOString(),
  });
  return jsonOk(data);
});
