/**
 * /api/digital-profile/search-surfaces/[surfaceId]
 *   DELETE — soft-delete a surface item (evidence is never hard-deleted).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { deleteSearchSurfaceItemSoft } from "@/modules/digital-profile/services/search-surface-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ surfaceId: string }> };

export const DELETE = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { surfaceId } = await ctx.params;
  const result = await deleteSearchSurfaceItemSoft(surfaceId, getActorContext(req));
  return jsonOk(result);
});
