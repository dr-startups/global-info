/**
 * /api/digital-profile/cases/[id]/search-surfaces/bulk
 *   POST — bulk import surface items (idempotent via [caseId, dedupHash])
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext, readJsonBody } from "@/modules/digital-profile/http/request";
import { createManySearchSurfaceItems } from "@/modules/digital-profile/services/search-surface-service";
import { BulkCreateSearchSurfaceItemsSchema } from "@/modules/digital-profile/validation/surface-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const { items } = BulkCreateSearchSurfaceItemsSchema.parse(await readJsonBody(req));
  const result = await createManySearchSurfaceItems(id, items, getActorContext(req));
  return jsonOk(result, 201);
});
