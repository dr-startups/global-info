/**
 * /api/digital-profile/screenshots/[id]/download?token=...
 *   GET — serve a screenshot from private storage, only with a valid signed token.
 *
 * Returns the raw image bytes (not the JSON envelope) on success.
 */

import { NextResponse, type NextRequest } from "next/server";
import { withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { getScreenshotForDownload } from "@/modules/digital-profile/services/screenshot-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  // Screenshots are raw evidence — staff only, never CLIENT_VIEWER (even with a
  // valid signed token).
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const file = await getScreenshotForDownload(id, token, actorOf(user));

  return new NextResponse(new Uint8Array(file.buffer), {
    status: 200,
    headers: {
      "content-type": file.mimeType,
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${id}"`,
    },
  });
});
