/**
 * RETIRED: POST /api/digital-profile/cases/[id]/report/render
 * REMEDIATION 9.3 — legacy v1–v3 PPTX/PDF render. Canonical: unified-collection/download.
 *
 * Note: report-builder-service / report-renderer-service / Python templates remain
 * for download helpers and internal use until a 9.3 follow-up.
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
