/**
 * POST /api/digital-profile/cases/[id]/orion-golden/client-content/regenerate
 * Regenerates pre/post-review client content from artifact-backed admin decisions.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import {
  persistRegeneratedClientContent,
  regenerateClientContentAfterReview,
} from "@/modules/digital-profile/orion-golden/services/admin-review-workflow-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "risk.review");
  await requireCaseAccess(user, id, "REVIEWER");
  const result = regenerateClientContentAfterReview(id);
  persistRegeneratedClientContent(id);
  return jsonOk({
    preReviewApprovedCount: result.preReview.approvedFindings.length,
    postReviewApprovedCount: result.postReview.approvedFindings.length,
    mode: "post_review",
  });
});
