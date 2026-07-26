/**
 * /api/digital-profile/cases/[id]/unified-collection/download?jobId=..&artifact=pdf|pptx|contactSheet
 *   GET — stream an accepted canonical report artifact for a completed unified job.
 *   Lineage-safe & fail-closed (see resolveCanonicalArtifactForDownload).
 *   Auth: requireDigitalProfileUser + requireCaseAccess(VIEWER).
 *   No legacy composer path; never creates artifacts; never sets REPORT_READY.
 */

import { readFileSync } from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { withModule } from "@/modules/digital-profile/http/errors";
import { requireCaseAccess, requireDigitalProfileUser } from "@/modules/digital-profile/auth/guard";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";
import { resolveCanonicalArtifactForDownload } from "@/modules/digital-profile/services/canonical-report-artifacts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  await requireCaseAccess(user, id, "VIEWER");

  const jobId = req.nextUrl.searchParams.get("jobId") ?? "";
  const artifact = req.nextUrl.searchParams.get("artifact") ?? "";
  const meta = await resolveCanonicalArtifactForDownload({ caseId: id, jobId, artifact });

  const buffer = readFileSync(meta.path);
  await recordAudit({
    caseId: id,
    action: "REPORT_DOWNLOADED",
    actorId: user.id,
    metadata: { mode: "canonical_unified_job", jobId: meta.jobId, artifact },
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
