/**
 * /api/digital-profile/screenshots/[id]
 *   DELETE — soft delete a screenshot (ADMIN only).
 *
 * Evidence is never hard-deleted: the file stays on disk, the record is flagged.
 * Requires `x-actor-role: admin` (placeholder until real RBAC lands).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  getActorContext,
  requireAdmin,
} from "@/modules/digital-profile/http/request";
import { softDeleteScreenshot } from "@/modules/digital-profile/services/screenshot-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const DELETE = withModule(async (req: NextRequest, ctx: RouteContext) => {
  requireAdmin(req);
  const { id } = await ctx.params;
  const data = await softDeleteScreenshot(id, getActorContext(req));
  return jsonOk(data);
});
