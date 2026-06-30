/**
 * GET /api/digital-profile/cases/[id]/evidence-quality
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { getCaseReviewQueue } from "@/modules/digital-profile/evidence-quality/case-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");
  const data = await getCaseReviewQueue(id);
  return jsonOk(data);
});
