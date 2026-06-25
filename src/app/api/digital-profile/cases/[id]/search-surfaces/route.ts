/**
 * /api/digital-profile/cases/[id]/search-surfaces
 *   GET  — list search surface items (optional ?type/?source/?provider filters)
 *   POST — create one surface item (manual import); duplicates are de-duped
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
import {
  createSearchSurfaceItem,
  listSearchSurfaceItems,
} from "@/modules/digital-profile/services/search-surface-service";
import {
  CreateSearchSurfaceItemSchema,
  ListSearchSurfacesQuerySchema,
} from "@/modules/digital-profile/validation/surface-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");
  const sp = req.nextUrl.searchParams;
  const filters = ListSearchSurfacesQuerySchema.parse({
    type: sp.get("type") ?? undefined,
    source: sp.get("source") ?? undefined,
    provider: sp.get("provider") ?? undefined,
  });
  const items = await listSearchSurfaceItems(id, filters);
  return jsonOk(items);
});

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");
  const input = CreateSearchSurfaceItemSchema.parse(await readJsonBody(req));
  const { item, deduplicated } = await createSearchSurfaceItem(id, input, actorOf(user));
  return jsonOk({ item, deduplicated }, deduplicated ? 200 : 201);
});
