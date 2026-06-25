/**
 * /api/digital-profile/cases/[id]/risk-findings
 *   POST — create a risk finding (requires >=1 evidence reference)
 *   GET  — list risk findings for the case
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  getActorContext,
  readJsonBody,
} from "@/modules/digital-profile/http/request";
import {
  addRiskFinding,
  listEvidence,
} from "@/modules/digital-profile/services/evidence-service";
import { AddRiskFindingSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const input = AddRiskFindingSchema.parse(await readJsonBody(req));
  const data = await addRiskFinding(id, input, getActorContext(req));
  return jsonOk(data, 201);
});

export const GET = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const evidence = await listEvidence(id);
  return jsonOk(evidence.riskFindings);
});
