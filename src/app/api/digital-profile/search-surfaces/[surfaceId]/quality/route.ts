/**
 * PATCH /api/digital-profile/search-surfaces/[surfaceId]/quality
 */

import type { NextRequest } from "next/server";
import { jsonOk, ValidationError, withModule } from "@/modules/digital-profile/http/errors";
import { requireDigitalProfileUser, requireRole } from "@/modules/digital-profile/auth/guard";
import { setSurfaceReportEligibility } from "@/modules/digital-profile/evidence-quality/case-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ surfaceId: string }> };

export const PATCH = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "risk.review");
  const { surfaceId } = await ctx.params;
  const body = (await req.json()) as { reportEligibility?: string };
  const allowed = ["CLIENT_INCLUDE", "INTERNAL_ONLY", "REVIEW_REQUIRED", "EXCLUDE"] as const;
  if (!body.reportEligibility || !allowed.includes(body.reportEligibility as (typeof allowed)[number])) {
    throw new ValidationError("reportEligibility must be CLIENT_INCLUDE | INTERNAL_ONLY | REVIEW_REQUIRED | EXCLUDE");
  }
  await setSurfaceReportEligibility(
    surfaceId,
    body.reportEligibility as (typeof allowed)[number]
  );
  return jsonOk({ ok: true });
});
