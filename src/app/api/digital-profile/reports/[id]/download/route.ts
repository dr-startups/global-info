/**
 * /api/digital-profile/reports/[id]/download?type=pptx|pdf&token=...
 *   GET — serve a rendered report file from private storage with a valid signed
 *         token. Returns raw bytes (not the JSON envelope) on success.
 */

import { NextResponse, type NextRequest } from "next/server";
import { withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { getReportFileForDownload } from "@/modules/digital-profile/services/report-renderer-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const type = req.nextUrl.searchParams.get("type") ?? "";
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const file = await getReportFileForDownload(
    id,
    type,
    token,
    getActorContext(req)
  );

  return new NextResponse(new Uint8Array(file.buffer), {
    status: 200,
    headers: {
      "content-type": file.mimeType,
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${file.filename}"`,
    },
  });
});
