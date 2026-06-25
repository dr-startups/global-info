/**
 * /api/digital-profile/cases/[id]/search-surfaces/bulk
 *   POST — bulk import surface items (idempotent via [caseId, dedupHash])
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { createManySearchSurfaceItems } from "@/modules/digital-profile/services/search-surface-service";
import { BulkCreateSearchSurfaceItemsSchema } from "@/modules/digital-profile/validation/surface-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");
  const { items } = BulkCreateSearchSurfaceItemsSchema.parse(await readJsonBody(req));
  const result = await createManySearchSurfaceItems(id, items, actorOf(user));
  return jsonOk(result, 201);
});
