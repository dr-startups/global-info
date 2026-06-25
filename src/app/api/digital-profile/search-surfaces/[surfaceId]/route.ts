/**
 * /api/digital-profile/search-surfaces/[surfaceId]
 *   DELETE — soft-delete a surface item (evidence is never hard-deleted).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { deleteSearchSurfaceItemSoft } from "@/modules/digital-profile/services/search-surface-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ surfaceId: string }> };

export const DELETE = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { surfaceId } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  // Soft-deleting evidence is an admin-only action.
  requireRole(user, "case.delete");
  const result = await deleteSearchSurfaceItemSoft(surfaceId, actorOf(user));
  return jsonOk(result);
});
