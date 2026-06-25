/**
 * /api/digital-profile/cases/[id]/agents/[agentName]/run
 *   POST — run a single (mock) agent for the case.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { runAgent } from "@/modules/digital-profile/services/agent-run-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; agentName: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id, agentName } = await ctx.params;
  const data = await runAgent(id, agentName, getActorContext(req));
  return jsonOk(data, 201);
});
