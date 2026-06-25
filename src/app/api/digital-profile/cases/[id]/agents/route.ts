/**
 * /api/digital-profile/cases/[id]/agents
 *   GET — list registered agents with each agent's most recent run.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { listAgents } from "@/modules/digital-profile/services/agent-run-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  return jsonOk(await listAgents(id));
});
