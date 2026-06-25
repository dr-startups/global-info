/**
 * /api/digital-profile/cases/[id]/audit-summary
 *   GET — build and return the audit summary on demand (no persistence).
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { buildAuditSummary } from "@/modules/digital-profile/audit-summary/builder";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");
  const auditSummary = await buildAuditSummary(id);
  return jsonOk({ auditSummary });
});
