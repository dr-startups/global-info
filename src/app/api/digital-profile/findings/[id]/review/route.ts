/**
 * /api/digital-profile/findings/[id]/review
 *   POST — mark a risk finding as reviewed / dismissed (human review gate).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  getActorContext,
  readJsonBody,
} from "@/modules/digital-profile/http/request";
import { reviewRiskFinding } from "@/modules/digital-profile/services/evidence-service";
import { ReviewRiskFindingSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const input = ReviewRiskFindingSchema.parse(await readJsonBody(req));
  const data = await reviewRiskFinding(id, input, getActorContext(req));
  return jsonOk(data);
});
