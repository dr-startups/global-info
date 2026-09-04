/**
 * /api/digital-profile/cases/[id]/persona-check
 *   POST — собрать панель различимых персон и записать снимок
 *   GET  — последний снимок и состояние ворот
 *
 * Ворот маршрут не проверяет: их единственный ответ — `personaGateState`, и
 * применяет его оркестратор на рождении прогона. Здесь состояние только
 * показывается, чтобы кабинет объяснил оператору, чего от него ждут.
 *
 * Роли — те же, что у маршрута старта сбора: решает тот, кто платит.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { digitalProfileConfig } from "@/modules/digital-profile/config";
import { loadCaseSubject } from "@/modules/digital-profile/agents/mock/mock-utils";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";
import {
  buildPersonaPanel,
  loadLatestPersonaCheck,
  loadPersonaGateInput,
  personaGateState,
  personaProbeOfCheck,
  recordPersonaCheck,
  subjectInputHash,
} from "@/modules/digital-profile/services/subject-persona-check";
import { loadCaseSubjectIdentityProfile } from "@/modules/digital-profile/services/subject-profile-admin";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "agents.run");
  if (!digitalProfileConfig.mockAgents) requireRole(user, "agents.runReal");
  await requireCaseAccess(user, id, "VIEWER");

  const subject = await loadCaseSubject(id);
  const { request, snapshot } = await buildPersonaPanel({
    subject: {
      caseId: id,
      fullName: subject.fullName,
      aliases: subject.aliases,
      dateOfBirth: subject.dateOfBirth,
      nationality: subject.nationality,
      country: subject.location,
    },
  });
  const row = await recordPersonaCheck({
    caseId: id,
    subjectInputHash: subjectInputHash(subject),
    request,
    snapshot,
    searchedBy: user.id,
  });
  await recordAudit({
    caseId: id,
    action: "PERSONA_PANEL_BUILT",
    actorId: user.id,
    metadata: {
      checkId: row.id,
      fetchStatus: snapshot.fetchStatus,
      cardCount: snapshot.cards.length,
      sources: snapshot.sources.map((s) => ({ source: s.source, status: s.status })),
    },
  });
  return jsonOk({ checkId: row.id, panel: snapshot }, 201);
});

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "agents.run");
  if (!digitalProfileConfig.mockAgents) requireRole(user, "agents.runReal");
  await requireCaseAccess(user, id, "VIEWER");

  const gateInput = await loadPersonaGateInput(id);
  const row = await loadLatestPersonaCheck(id);
  /*
   * Признаки читаются из профиля кейса, а проба считается здесь и сейчас.
   *
   * Оператор правит признаки после того, как панель уже куплена, и должен
   * увидеть новый ответ, не покупая её заново. Замороженная в снимке проба
   * отвечала бы на вопрос о прежних признаках.
   */
  const anchors = loadCaseSubjectIdentityProfile(id)?.anchors ?? null;
  return jsonOk({
    gate: personaGateState(gateInput),
    probe: personaProbeOfCheck({ personasJson: row?.personasJson ?? null, anchors }),
    check: row
      ? {
          checkId: row.id,
          panel: row.personasJson,
          decision: row.decision,
          decidedBy: row.decidedBy,
          decidedAt: row.decidedAt,
          searchedAt: row.searchedAt,
          // Строка со свежим хешем — та, по которой решение ещё принимают:
          // после правки данных субъекта прежний снимок относится к другому
          // вопросу, и решать по нему нельзя.
          matchesCurrentSubject: row.subjectInputHash === gateInput.subjectInputHash,
        }
      : null,
  });
});
