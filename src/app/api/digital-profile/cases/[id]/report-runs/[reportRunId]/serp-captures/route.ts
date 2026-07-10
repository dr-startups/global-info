/**
 * GET /api/digital-profile/cases/[id]/report-runs/[reportRunId]/serp-captures
 */

import type { NextRequest } from "next/server";
import { jsonOk, ValidationError, withModule } from "@/modules/digital-profile/http/errors";
import { requireOrionAdminApiAccess } from "@/modules/digital-profile/orion-golden/auth/orion-admin-auth";
import {
  listSerpCapturesForRun,
  SerpUrlBuilderError,
} from "@/modules/digital-profile/serp-capture";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string; reportRunId: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id: caseId, reportRunId } = await ctx.params;
  await requireOrionAdminApiAccess(req, caseId, "view");

  try {
    // Do not create a run on GET — only list. Missing run → empty list (not an error).
    const captures = await listSerpCapturesForRun(reportRunId);
    console.info("[serp-capture] API list", {
      caseId,
      reportRunId,
      count: captures.length,
      statuses: captures.map((c) => c.captureStatus),
    });
    return jsonOk({ captures });
  } catch (err) {
    if (err instanceof SerpUrlBuilderError) {
      throw new ValidationError(err.message);
    }
    throw err;
  }
});
