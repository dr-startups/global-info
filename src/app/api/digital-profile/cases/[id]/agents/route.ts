/**
 * /api/digital-profile/cases/[id]/agents
 *   GET — list registered agents with each agent's most recent run.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { listAgents } from "@/modules/digital-profile/services/agent-run-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  // Agents/run internals are staff-only (hidden from CLIENT_VIEWER).
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");
  return jsonOk(await listAgents(id));
});
