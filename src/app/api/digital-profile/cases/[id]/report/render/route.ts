/**
 * /api/digital-profile/cases/[id]/report/render
 *   POST — render the latest (or specified) report version into PPTX + PDF via
 *          the renderer microservice and store the artifact keys.
 *
 * Optional JSON body: { "version": number }.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { renderReportVersion } from "@/modules/digital-profile/services/report-renderer-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  let version: number | undefined;
  try {
    const body = (await req.json()) as { version?: number } | null;
    if (body && typeof body.version === "number") version = body.version;
  } catch {
    // No/invalid body: render the latest version.
  }
  const data = await renderReportVersion(id, version, getActorContext(req));
  return jsonOk(data, 201);
});
