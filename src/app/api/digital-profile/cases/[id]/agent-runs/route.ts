/**
 * /api/digital-profile/cases/[id]/agent-runs
 *   GET — recent agent run history for the case.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { listAgentRuns } from "@/modules/digital-profile/services/agent-run-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withModule(async (_req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  return jsonOk(await listAgentRuns(id));
});
