/**
 * /api/digital-profile/search-results/[id]
 *   PATCH — classify a search result and/or set its review status
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  getActorContext,
  readJsonBody,
} from "@/modules/digital-profile/http/request";
import { classifySearchResult } from "@/modules/digital-profile/services/evidence-service";
import { ClassifySearchResultSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const PATCH = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const input = ClassifySearchResultSchema.parse(await readJsonBody(req));
  const data = await classifySearchResult(id, input, getActorContext(req));
  return jsonOk(data);
});
