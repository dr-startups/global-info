/**
 * /api/digital-profile/cases/[id]/audit/run
 *   POST — run the full (mock) audit: all agents in order. A failing agent does
 *   not abort the others; the response carries the overall outcome.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { getActorContext } from "@/modules/digital-profile/http/request";
import { runFullAudit } from "@/modules/digital-profile/services/agent-run-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const data = await runFullAudit(id, getActorContext(req));
  return jsonOk(data, 201);
});
