import { NextResponse, type NextRequest } from "next/server";
import { withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
} from "@/modules/digital-profile/auth/guard";
import { loadFile } from "@/modules/digital-profile/storage/private-store";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";
import { resolveOrionArtifactForDownload } from "@/modules/digital-profile/services/orion-v2-report-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  await requireCaseAccess(user, id, "VIEWER");

  const runId = req.nextUrl.searchParams.get("runId") ?? "";
  const artifact = req.nextUrl.searchParams.get("artifact") ?? "";
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const meta = resolveOrionArtifactForDownload({
    caseId: id,
    role: user.role,
    runId,
    artifact,
    token,
  });

  const buffer = await loadFile(meta.storageKey);
  await recordAudit({
    caseId: id,
    action: "REPORT_DOWNLOADED",
    actorId: user.id,
    metadata: {
      mode: "orion_v2",
      runId,
      artifact,
    },
  });

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "content-type": meta.mimeType,
      "cache-control": "private, no-store",
      "content-disposition": `inline; filename="${meta.fileName}"`,
    },
  });
});

