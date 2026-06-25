/**
 * /api/digital-profile/cases/[id]/report/render
 *   POST — render the latest (or specified) report version into PPTX + PDF via
 *          the renderer microservice and store the artifact keys.
 *
 * Optional JSON body: {
 *   "version": number,
 *   "templateVersion": string,
 *   "audience": "internal" | "client",
 *   "watermarkMode": "draft" | "none",
 *   "reportLanguage": "ru" | "en"
 * }.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { renderReportVersion } from "@/modules/digital-profile/services/report-renderer-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  let version: number | undefined;
  let templateVersion: string | undefined;
  let audience: "internal" | "client" | undefined;
  let watermarkMode: "draft" | "none" | undefined;
  let reportLanguage: "ru" | "en" | undefined;
  try {
    const body = (await req.json()) as
      | {
          version?: number;
          templateVersion?: string;
          audience?: string;
          watermarkMode?: string;
          reportLanguage?: string;
        }
      | null;
    if (body && typeof body.version === "number") version = body.version;
    if (body && typeof body.templateVersion === "string") {
      templateVersion = body.templateVersion;
    }
    if (body && (body.audience === "internal" || body.audience === "client")) {
      audience = body.audience;
    }
    if (body && (body.watermarkMode === "draft" || body.watermarkMode === "none")) {
      watermarkMode = body.watermarkMode;
    }
    if (body && (body.reportLanguage === "ru" || body.reportLanguage === "en")) {
      reportLanguage = body.reportLanguage;
    }
  } catch {
    // No/invalid body: render the latest version with defaults.
  }
  const data = await renderReportVersion(id, version, getActorContext(req), {
    templateVersion,
    audience,
    watermarkMode,
    reportLanguage,
  });
  return jsonOk(data, 201);
});
