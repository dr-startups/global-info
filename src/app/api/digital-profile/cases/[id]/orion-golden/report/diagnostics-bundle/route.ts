/**
 * RETIRED: GET /api/digital-profile/cases/[id]/orion-golden/report/diagnostics-bundle
 *
 * The legacy classic audit diagnostics bundle is retired together with the
 * monolithic composer. Canonical job artifacts live under the unified job and
 * are retrieved via /unified-collection (status) and /unified-collection/download.
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
          "The legacy diagnostics bundle path is retired. Use the unified job status and canonical download endpoints.",
        details: {
          canonicalStatus: `/api/digital-profile/cases/${id}/unified-collection`,
        },
      },
    },
    { status: 410 }
  );
});
