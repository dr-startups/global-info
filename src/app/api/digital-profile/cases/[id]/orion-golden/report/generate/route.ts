/**
 * RETIRED: POST/GET /api/digital-profile/cases/[id]/orion-golden/report/generate
 *
 * The legacy monolithic ORION Classic audit composer has been retired. Report
 * generation is now owned exclusively by the unified canonical job (single CTA):
 *   POST /api/digital-profile/cases/[id]/unified-collection
 * and accepted artifacts are downloaded via:
 *   GET  /api/digital-profile/cases/[id]/unified-collection/download?jobId=..&artifact=pdf|pptx
 *
 * This route never imports the legacy composer, never creates legacy artifacts and
 * never sets REPORT_READY. It returns an explicit LEGACY_REPORT_PATH_RETIRED code.
 */

import { NextResponse, type NextRequest } from "next/server";
import { withModule } from "@/modules/digital-profile/http/errors";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function retired(caseId: string): NextResponse {
  return NextResponse.json(
    {
      ok: false as const,
      error: {
        code: "LEGACY_REPORT_PATH_RETIRED",
        message:
          "The legacy ORION Classic report path is retired. Run the unified audit (POST /unified-collection) and download accepted artifacts from /unified-collection/download.",
        details: {
          canonicalStart: `/api/digital-profile/cases/${caseId}/unified-collection`,
          canonicalStatus: `/api/digital-profile/cases/${caseId}/unified-collection`,
          canonicalDownload: `/api/digital-profile/cases/${caseId}/unified-collection/download`,
        },
      },
    },
    { status: 410 }
  );
}

export const POST = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  return retired(id);
});

export const GET = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  return retired(id);
});
