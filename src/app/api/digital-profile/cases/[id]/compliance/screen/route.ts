/**
 * POST /api/digital-profile/cases/[id]/compliance/screen
 * Run a compliance screening via provider stub (no live API without credentials).
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
import { runComplianceScreening } from "@/modules/digital-profile/compliance-providers";
import { ComplianceScreeningSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");
  const input = ComplianceScreeningSchema.parse(await readJsonBody(req));
  const result = await runComplianceScreening(id, input.provider, actorOf(user));
  return jsonOk(result, result.status === "SUCCESS" ? 201 : 200);
});
