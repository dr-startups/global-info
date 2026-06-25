/**
 * /api/digital-profile/search-results/[id]
 *   PATCH — classify a search result and/or set its review status
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  actorOf,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { classifySearchResult } from "@/modules/digital-profile/services/evidence-service";
import { ClassifySearchResultSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const PATCH = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  const input = ClassifySearchResultSchema.parse(await readJsonBody(req));
  const data = await classifySearchResult(id, input, actorOf(user));
  return jsonOk(data);
});
