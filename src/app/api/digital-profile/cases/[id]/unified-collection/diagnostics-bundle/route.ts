/**
 * GET /api/digital-profile/cases/[id]/unified-collection/diagnostics-bundle?jobId=…
 *
 * REMEDIATION §8.3 — zip of JSON/text job artifacts for support (no binaries,
 * secrets redacted). Auth: staff with evidence.viewRaw.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  withModule,
  ValidationError,
} from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";
import { buildUnifiedDiagnosticsBundle } from "@/modules/digital-profile/services/unified-diagnostics-bundle";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");

  const jobId = req.nextUrl.searchParams.get("jobId") ?? "";
  if (!jobId.trim()) throw new ValidationError("jobId is required");

  const bundle = await buildUnifiedDiagnosticsBundle({ caseId: id, jobId });
  const actor = actorOf(user);
  await recordAudit({
    caseId: id,
    action: "DIAGNOSTICS_BUNDLE_DOWNLOADED",
    actorId: actor.actorId ?? user.id,
    metadata: {
      mode: "unified_diagnostics_bundle",
      jobId,
      includedCount: bundle.includedCount,
      skippedBinaryCount: bundle.skippedBinaryCount,
      skippedOversizeCount: bundle.skippedOversizeCount,
    },
  });

  return new NextResponse(new Uint8Array(bundle.zipBuffer), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${bundle.fileName}"`,
    },
  });
});
