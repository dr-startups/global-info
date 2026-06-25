/**
 * /api/digital-profile/cases/[id]/audit-summary
 *   GET — build and return the audit summary on demand (no persistence).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { buildAuditSummary } from "@/modules/digital-profile/audit-summary/builder";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const auditSummary = await buildAuditSummary(id);
  return jsonOk({ auditSummary });
});
