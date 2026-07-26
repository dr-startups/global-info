/**
 * /api/digital-profile/cases/[id]/agents/[agentName]/run
 *   POST — run a single (mock) agent for the case.
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
import { runAgent } from "@/modules/digital-profile/services/agent-run-service";

export const dynamic = "force-dynamic";
/**
 * Arsenkin CaseAgents await /set→/check→/get in-request.
 * check-top alone can take 5+ minutes per task; allow headroom for multi-task plans.
 */
export const maxDuration = 1200;

type RouteContext = { params: Promise<{ id: string; agentName: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id, agentName } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "agents.run");
  if (!digitalProfileConfig.mockAgents) requireRole(user, "agents.runReal");
  // Скрытая в UI кнопка ничего не гарантирует — это уже выяснилось на пункте 1
  // шага 11.2, где `runAgent` запускал любого агента по имени мимо проверки
  // доступности. Поэтому режим отладки закрыт и на сервере.
  if (!digitalProfileConfig.manualAgentRun) {
    throw new Error(
      "AGENT_MANUAL_RUN_DISABLED: агенты — шаги оркеструемого прогона; " +
        "повторы ведёт система. Для отладки: DIGITAL_PROFILE_MANUAL_AGENT_RUN=true"
    );
  }
  await requireCaseAccess(user, id, "VIEWER");
  const data = await runAgent(id, agentName, actorOf(user));
  return jsonOk(data, 201);
});
