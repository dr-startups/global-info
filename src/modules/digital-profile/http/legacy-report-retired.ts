import { NextResponse } from "next/server";

/**
 * Shared 410 payload for retired legacy report HTTP surfaces (REMEDIATION 9.3).
 * Canonical path: unified-collection + unified-collection/download.
 */
export function legacyReportPathRetired(caseId: string): NextResponse {
  return NextResponse.json(
    {
      ok: false as const,
      error: {
        code: "LEGACY_REPORT_PATH_RETIRED",
        message:
          "This legacy report path is retired. Run the unified audit (POST /unified-collection) and download accepted artifacts from /unified-collection/download.",
        details: {
          canonicalStart: `/api/digital-profile/cases/${caseId}/unified-collection`,
          canonicalStatus: `/api/digital-profile/cases/${caseId}/unified-collection`,
          canonicalDownload: `/api/digital-profile/cases/${caseId}/unified-collection/download`,
        },
      },
    },
    { status: 410 }
  );
}
