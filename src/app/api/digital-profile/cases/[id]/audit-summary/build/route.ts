/**
 * /api/digital-profile/cases/[id]/audit-summary/build
 *   POST — build the audit summary and record the run in the audit log.
 *          Read-only over evidence; reviewed/dismissed findings are preserved.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { buildAuditSummary } from "@/modules/digital-profile/audit-summary/builder";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const actor = getActorContext(req);
  const auditSummary = await buildAuditSummary(id);
  await recordAudit({
    caseId: id,
    action: "AUDIT_SUMMARY_BUILT",
    actorId: actor.actorId,
    metadata: {
      overallRiskLevel: auditSummary.overallRiskLevel,
      evidenceCount: auditSummary.dataQualitySummary.evidenceCount,
      totalFindings: auditSummary.riskSummary.totalFindings,
    },
  });
  return jsonOk({ auditSummary });
});
