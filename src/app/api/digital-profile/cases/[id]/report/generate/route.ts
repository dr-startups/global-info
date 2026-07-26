/**
 * RETIRED: POST /api/digital-profile/cases/[id]/report/generate
 * REMEDIATION 9.3 — legacy report_json generate. Canonical: unified-collection.
 */

import type { NextRequest } from "next/server";
import { withModule } from "@/modules/digital-profile/http/errors";
import { legacyReportPathRetired } from "@/modules/digital-profile/http/legacy-report-retired";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  return legacyReportPathRetired(id);
});
