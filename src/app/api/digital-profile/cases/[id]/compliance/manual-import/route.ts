/**
 * POST /api/digital-profile/cases/[id]/compliance/manual-import
 * Add a manual compliance database hit (primary C1 workflow).
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
import { importManualComplianceHit } from "@/modules/digital-profile/compliance-providers";
import { ManualComplianceImportSchema } from "@/modules/digital-profile/validation/evidence-schemas";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");
  const input = ManualComplianceImportSchema.parse(await readJsonBody(req));
  const row = await importManualComplianceHit(id, input, actorOf(user));
  return jsonOk(row, 201);
});
