/**
 * RETIRED: GET /api/digital-profile/cases/[id]/report/orion-v2/download
 * REMEDIATION 9.3
 */

import type { NextRequest } from "next/server";
import { withModule } from "@/modules/digital-profile/http/errors";
import { legacyReportPathRetired } from "@/modules/digital-profile/http/legacy-report-retired";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  return legacyReportPathRetired(id);
});
