/**
 * /api/digital-profile/cases/[id]/report/generate
 *   POST — build report_json from current evidence and save a new DRAFT report
 *          version. (PPTX/PDF rendering is added in Stage E.)
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { createReportVersion } from "@/modules/digital-profile/services/report-builder-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "report.generateInternal");
  await requireCaseAccess(user, id, "VIEWER");
  let reportLanguage: "ru" | "en" | undefined;
  try {
    const body = (await req.json()) as { reportLanguage?: string } | null;
    if (body?.reportLanguage === "ru" || body?.reportLanguage === "en") {
      reportLanguage = body.reportLanguage;
    }
  } catch {
    /* no body */
  }
  const data = await createReportVersion(id, actorOf(user), { language: reportLanguage });
  return jsonOk(data, 201);
});
