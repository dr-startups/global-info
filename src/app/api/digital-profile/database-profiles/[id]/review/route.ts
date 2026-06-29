/**
 * PATCH /api/digital-profile/database-profiles/[id]/review
 * Analyst review of a compliance hit.
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
import { reviewComplianceHit } from "@/modules/digital-profile/compliance-providers";
import { ComplianceHitReviewSchema } from "@/modules/digital-profile/validation/evidence-schemas";
import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "@/modules/digital-profile/http/errors";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const PATCH = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.create");
  const input = ComplianceHitReviewSchema.parse(await readJsonBody(req));

  const hit = await prisma.databaseProfile.findUnique({ where: { id }, select: { caseId: true } });
  if (!hit) throw new NotFoundError("Compliance hit not found");
  await requireCaseAccess(user, hit.caseId, "EDITOR");

  const row = await reviewComplianceHit(id, input.reviewStatus, actorOf(user));
  return jsonOk(row);
});
