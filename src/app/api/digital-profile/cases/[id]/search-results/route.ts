/**
 * /api/digital-profile/cases/[id]/search-results
 *   POST — add a (manual) search result; URLs are de-duplicated per case
 *   GET  — list search results for the case
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
  addSearchResult,
  listEvidence,
} from "@/modules/digital-profile/services/evidence-service";
import { AddSearchResultSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");
  const input = AddSearchResultSchema.parse(await readJsonBody(req));
  const { result, deduplicated } = await addSearchResult(id, input, actorOf(user));
  // 200 when an existing (deduplicated) record was returned, 201 when created.
  return jsonOk({ result, deduplicated }, deduplicated ? 200 : 201);
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");
  const evidence = await listEvidence(id);
  return jsonOk(evidence.searchResults);
});
