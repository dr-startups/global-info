/**
 * GET /api/digital-profile/cases/[id]/orion-golden/admin-review-decisions
 * R10.10a — fail-closed ORION admin auth.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { requireOrionAdminApiAccess } from "@/modules/digital-profile/orion-golden/auth/orion-admin-auth";
import { listAdminReviewDecisions } from "@/modules/digital-profile/orion-golden/services/admin-review-workflow-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  await requireOrionAdminApiAccess(req, id, "view");
  const data = listAdminReviewDecisions(id);
  return jsonOk(data);
});
