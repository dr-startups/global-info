/**
 * /api/digital-profile/cases/[id]/report
 *   GET — return the latest report version (report_json + metadata).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { getLatestReport } from "@/modules/digital-profile/services/report-builder-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  // report_json carries internal pages — staff only (not CLIENT_VIEWER).
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");
  const data = await getLatestReport(id, actorOf(user));
  return jsonOk(data);
});
