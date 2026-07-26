/**
 * RETIRED: POST /api/digital-profile/cases/[id]/report/render
 * REMEDIATION 9.3 — legacy v1–v3 PPTX/PDF render. Canonical: unified-collection/download.
 *
 * Historical ReportVersion files remain downloadable via /reports/[id]/download
 * (streaming only; Python report_template_v* deleted).
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
