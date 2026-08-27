/**
 * /api/digital-profile/cases/[id]/persona-check/decision
 *   POST — решение оператора по собранной панели
 *
 * Два ответа и только два: «это он» на одной карточке либо «различимой персоны
 * нет — продолжить». Отказа третьим состоянием нет: не тот человек — оператор
 * заводит кейс с верными данными.
 *
 * Роли — те же, что у маршрута старта сбора: решает тот, кто платит.
 */

import type { NextRequest } from "next/server";
import { ValidationError, jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { digitalProfileConfig } from "@/modules/digital-profile/config";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";
import {
  recordPersonaDecision,
  type PersonaDecision,
} from "@/modules/digital-profile/services/subject-persona-check";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const DECISIONS: PersonaDecision[] = ["PERSONA_SELECTED", "APPROVED_WITHOUT_PERSONA"];

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "agents.run");
  if (!digitalProfileConfig.mockAgents) requireRole(user, "agents.runReal");
  await requireCaseAccess(user, id, "VIEWER");

  const body = (await readJsonBody(req)) as Record<string, unknown>;
  const checkId = String(body.checkId ?? "").trim();
  if (!checkId) throw new ValidationError("checkId is required");
  const decision = String(body.decision ?? "") as PersonaDecision;
  if (!DECISIONS.includes(decision)) {
    throw new ValidationError(`decision must be one of ${DECISIONS.join(", ")}`);
  }
  const selectedCardId =
    typeof body.selectedCardId === "string" ? body.selectedCardId.trim() : null;

  const row = await recordPersonaDecision({
    caseId: id,
    checkId,
    decision,
    selectedCardId,
    decidedBy: user.id,
  });
  await recordAudit({
    caseId: id,
    action: "PERSONA_DECIDED",
    actorId: user.id,
    metadata: {
      checkId: row.id,
      decision: row.decision,
      selectedCardId,
      // Пустая панель — валидное состояние решения, и причина пустоты по
      // каждому источнику остаётся в снимке строки.
      fetchStatus: row.fetchStatus,
    },
  });
  return jsonOk({
    checkId: row.id,
    decision: row.decision,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    selectedPersona: row.selectedPersonaJson,
  });
});
