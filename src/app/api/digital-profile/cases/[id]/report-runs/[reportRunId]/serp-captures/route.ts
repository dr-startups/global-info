/**
 * GET /api/digital-profile/cases/[id]/report-runs/[reportRunId]/serp-captures
 */

import type { NextRequest } from "next/server";
import { jsonOk, ValidationError, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import {
  assertReportRunBelongsToCase,
  listSerpCapturesForRun,
  SerpUrlBuilderError,
} from "@/modules/digital-profile/serp-capture";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string; reportRunId: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id: caseId, reportRunId } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, caseId, "VIEWER");

  try {
    await assertReportRunBelongsToCase(caseId, reportRunId);
  } catch (err) {
    if (err instanceof SerpUrlBuilderError) {
      throw new ValidationError(err.message);
    }
    throw err;
  }

  const captures = await listSerpCapturesForRun(reportRunId);
  return jsonOk({ captures });
});
