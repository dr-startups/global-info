/**
 * /api/digital-profile/cases/[id]/report/generate
 *   POST — build report_json from current evidence and save a new DRAFT report
 *          version. (PPTX/PDF rendering is added in Stage E.)
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { createReportVersion } from "@/modules/digital-profile/services/report-builder-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const data = await createReportVersion(id, getActorContext(req));
  return jsonOk(data, 201);
});
