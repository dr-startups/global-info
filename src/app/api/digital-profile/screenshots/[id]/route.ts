/**
 * /api/digital-profile/screenshots/[id]
 *   DELETE — soft delete a screenshot (ADMIN / SUPER_ADMIN only).
 *
 * Evidence is never hard-deleted: the file stays on disk, the record is flagged.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { softDeleteScreenshot } from "@/modules/digital-profile/services/screenshot-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const DELETE = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "case.delete");
  const { id } = await ctx.params;
  const data = await softDeleteScreenshot(id, actorOf(user));
  return jsonOk(data);
});
