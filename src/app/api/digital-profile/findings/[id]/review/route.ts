/**
 * /api/digital-profile/findings/[id]/review
 *   POST — mark a risk finding as reviewed / dismissed (human review gate).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  actorOf,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { reviewRiskFinding } from "@/modules/digital-profile/services/evidence-service";
import { ReviewRiskFindingSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  // Finding is identified by id; only staff (ADMIN/REVIEWER) may review, and
  // staff have global case access, so a role check is sufficient here.
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "risk.review");
  const input = ReviewRiskFindingSchema.parse(await readJsonBody(req));
  const data = await reviewRiskFinding(id, input, actorOf(user));
  return jsonOk(data);
});
