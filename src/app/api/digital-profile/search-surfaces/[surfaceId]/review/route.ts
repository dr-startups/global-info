/**
 * /api/digital-profile/search-surfaces/[surfaceId]/review
 *   PATCH — set a surface item's review status (human review gate).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  actorOf,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { markSearchSurfaceItemReviewed } from "@/modules/digital-profile/services/search-surface-service";
import { ReviewSearchSurfaceItemSchema } from "@/modules/digital-profile/validation/surface-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ surfaceId: string }> };

export const PATCH = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { surfaceId } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "risk.review");
  const { reviewStatus } = ReviewSearchSurfaceItemSchema.parse(await readJsonBody(req));
  const item = await markSearchSurfaceItemReviewed(surfaceId, reviewStatus, actorOf(user));
  return jsonOk(item);
});
