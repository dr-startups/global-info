/**
 * /api/digital-profile/cases/[id]/audit/run
 *   POST — run the full (mock) audit: all agents in order. A failing agent does
 *   not abort the others; the response carries the overall outcome.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { digitalProfileConfig } from "@/modules/digital-profile/config";
import { parseRuntimeMode } from "@/modules/digital-profile/agents/runtime-strategy";
import { runFullAudit } from "@/modules/digital-profile/services/agent-run-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "agents.run");
  // Running real (non-mock) providers requires the stronger permission.
  if (!digitalProfileConfig.mockAgents) requireRole(user, "agents.runReal");
  await requireCaseAccess(user, id, "VIEWER");
  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const mode = parseRuntimeMode((body as { runtimeMode?: unknown }).runtimeMode);
  const data = await runFullAudit(id, actorOf(user), { runtimeMode: mode });
  return jsonOk(data, 201);
});
