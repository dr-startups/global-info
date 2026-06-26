/**
 * /api/digital-profile/cases/[id]/search-results/classify
 *   POST — run the deterministic Stage N1.3 result classifier over stored
 *          search_results, persist classification into rawMetadata and upsert
 *          risk_findings for risky results (idempotent, review-safe).
 *
 * Deterministic only: no LLM, no scraping, no network, no API keys.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { classifyCaseSearchResults } from "@/modules/digital-profile/services/result-classification-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "risk.classify");
  await requireCaseAccess(user, id, "EDITOR");
  const summary = await classifyCaseSearchResults(id, actorOf(user));
  return jsonOk(summary);
});
