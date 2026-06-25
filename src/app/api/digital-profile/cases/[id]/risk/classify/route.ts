/**
 * /api/digital-profile/cases/[id]/risk/classify
 *   POST — run the deterministic Risk Classifier v1 over stored evidence and
 *          persist idempotent, review-first risk findings.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { classifyCaseRisks } from "@/modules/digital-profile/services/risk-finding-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const summary = await classifyCaseRisks(id, getActorContext(req));
  return jsonOk(summary);
});
