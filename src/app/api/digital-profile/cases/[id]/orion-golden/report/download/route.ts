/**
 * RETIRED: GET /api/digital-profile/cases/[id]/orion-golden/report/download
 *
 * The legacy classic audit artifact download is retired. Accepted canonical
 * artifacts are served by the lineage-safe unified download endpoint:
 *   GET /api/digital-profile/cases/[id]/unified-collection/download?jobId=..&artifact=pdf|pptx
 *
 * This route never imports the legacy composer/audit-report service.
 */

import { NextResponse, type NextRequest } from "next/server";
import { withModule } from "@/modules/digital-profile/http/errors";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  return NextResponse.json(
    {
      ok: false as const,
      error: {
        code: "LEGACY_REPORT_PATH_RETIRED",
        message:
          "The legacy report download path is retired. Download accepted artifacts from /unified-collection/download?jobId=..&artifact=pdf|pptx.",
        details: {
          canonicalDownload: `/api/digital-profile/cases/${id}/unified-collection/download`,
        },
      },
    },
    { status: 410 }
  );
});
