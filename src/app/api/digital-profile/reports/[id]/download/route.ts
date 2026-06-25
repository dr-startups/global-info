/**
 * /api/digital-profile/reports/[id]/download?type=pptx|pdf&token=...
 *   GET — serve a rendered report file from private storage with a valid signed
 *         token AND (when auth is enabled) the right role + case access.
 *
 * A valid signed token never bypasses authorization. CLIENT_VIEWER may only
 * download client-safe (non-draft / no-watermark) reports for an assigned case;
 * internal/draft reports are staff-only.
 */

import { NextResponse, type NextRequest } from "next/server";
import { ForbiddenError, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
} from "@/modules/digital-profile/auth/guard";
import { can } from "@/modules/digital-profile/auth/roles";
import { getReportFileForDownload } from "@/modules/digital-profile/services/report-renderer-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const type = req.nextUrl.searchParams.get("type") ?? "";
  const token = req.nextUrl.searchParams.get("token") ?? "";

  const user = await requireDigitalProfileUser(req);

  const file = await getReportFileForDownload(
    id,
    type,
    token,
    actorOf(user),
    async (meta) => {
      const isDraft =
        meta.status !== "FINAL" || !!(meta.watermark && meta.watermark.trim());
      await requireCaseAccess(user, meta.caseId, "VIEWER");

      if (user.role === "CLIENT_VIEWER") {
        // Client viewers: client-safe reports only, never internal drafts.
        if (isDraft || !can(user.role, "report.downloadClient")) {
          throw new ForbiddenError("Report not available for download");
        }
        return;
      }
      // Staff need at least the internal-download capability.
      if (!can(user.role, "report.downloadInternal")) {
        throw new ForbiddenError("Report not available for download");
      }
    }
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
