/**
 * /api/digital-profile/cases/[id]/report
 *   GET — return the latest report version (report_json + metadata).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { getLatestReport } from "@/modules/digital-profile/services/report-builder-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const data = await getLatestReport(id, getActorContext(req));
  return jsonOk(data);
});
