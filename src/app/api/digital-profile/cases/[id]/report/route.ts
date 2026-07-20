/**
 * RETIRED: GET /api/digital-profile/cases/[id]/report
 * REMEDIATION 9.3 — legacy latest report_json. Canonical: unified-collection.
 */

import type { NextRequest } from "next/server";
import { withModule } from "@/modules/digital-profile/http/errors";
import { legacyReportPathRetired } from "@/modules/digital-profile/http/legacy-report-retired";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");
  return legacyReportPathRetired(id);
});
