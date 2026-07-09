/**
 * POST/GET /api/digital-profile/cases/[id]/orion-golden/report/generate
 * Classic ORION audit PDF/PPTX (post-review content + full commercial pack).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { digitalProfileConfig } from "@/modules/digital-profile/config";
import { ForbiddenError } from "@/modules/digital-profile/http/errors";
import {
  assertCanRegenerateClientContent,
  requireOrionAdminApiAccess,
} from "@/modules/digital-profile/orion-golden/auth/orion-admin-auth";
import {
  enqueueOrionClassicAuditReport,
  getOrionClassicAuditSummary,
  isOrionClassicAuditUiEnabled,
} from "@/modules/digital-profile/services/orion-classic-audit-report-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireOrionAdminApiAccess(req, id, "review");
  assertCanRegenerateClientContent(user);

  if (!digitalProfileConfig.orionGoldenEnabled || !isOrionClassicAuditUiEnabled()) {
    throw new ForbiddenError("ORION Classic Audit is disabled.");
  }

  const body = (await req.json().catch(() => ({}))) as { regenerateContent?: boolean };
  const summary = await enqueueOrionClassicAuditReport({
    caseId: id,
    regenerateContent: Boolean(body.regenerateContent),
  });
  return jsonOk(summary, summary.status === "running" ? 202 : 200);
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  await requireOrionAdminApiAccess(req, id, "view");
  return jsonOk(getOrionClassicAuditSummary(id));
});
