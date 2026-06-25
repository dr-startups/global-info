/**
 * /api/digital-profile/cases/[id]/search-queries
 *   POST — add a (manual) search query
 *   GET  — list search queries for the case
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  getActorContext,
  readJsonBody,
} from "@/modules/digital-profile/http/request";
import {
  addSearchQuery,
  listEvidence,
} from "@/modules/digital-profile/services/evidence-service";
import { AddSearchQuerySchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const input = AddSearchQuerySchema.parse(await readJsonBody(req));
  const data = await addSearchQuery(id, input, getActorContext(req));
  return jsonOk(data, 201);
});

export const GET = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const evidence = await listEvidence(id);
  return jsonOk(evidence.searchQueries);
});
