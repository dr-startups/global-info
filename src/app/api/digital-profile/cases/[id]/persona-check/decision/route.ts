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
import { loadCaseSubjectIdentityProfile } from "@/modules/digital-profile/services/subject-profile-admin";
import { applyCardAnchorsToProfile } from "@/modules/digital-profile/services/persona-card-anchors";
import { wikipediaProvider } from "@/modules/digital-profile/providers/wikipedia-provider";
import { loadCaseSubject } from "@/modules/digital-profile/agents/mock/mock-utils";
import type { PersonaCard } from "@/modules/digital-profile/services/subject-persona-check";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const DECISIONS: PersonaDecision[] = [
  "PERSONA_SELECTED",
  "ANCHORS_CONFIRMED",
  "APPROVED_WITHOUT_PERSONA",
];

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

  /*
   * Признаки берутся из профиля кейса, а не из тела запроса: у вопроса «чем
   * субъект отличается от тёзок» один владелец — файл профиля, который правит
   * оператор. Иначе решение записывалось бы по одним признакам, а разметка шла
   * по другим.
   */
  const anchors =
    decision === "ANCHORS_CONFIRMED"
      ? loadCaseSubjectIdentityProfile(id)?.anchors ?? null
      : null;
  const row = await recordPersonaDecision({
    caseId: id,
    checkId,
    decision,
    selectedCardId,
    anchors,
    decidedBy: user.id,
  });
  /*
   * Карточку выбрал человек глазами — её слова становятся признаками субъекта.
   *
   * Известному человеку иначе пришлось бы вводить руками то, что уже написано
   * в подтверждённой им карточке. Признак при этом добыт не из размечаемого
   * корпуса, а из отдельного источника; фразы видны в форме признаков, и
   * оператор снимает их одним щелчком.
   *
   * Падение здесь не отменяет записанного решения: оператор видит ошибку и
   * жмёт ещё раз — тот же ответ по той же строке принимается, а слияние
   * признаков идемпотентно.
   */
  let cardAnchorPhrases = 0;
  let cardStructured = false;
  let cardBirthDateMismatch: { card: string; subject: string } | null = null;
  const selectedCard = (row.selectedPersonaJson as { card?: PersonaCard } | null)?.card;
  if (row.decision === "PERSONA_SELECTED" && selectedCard) {
    const subject = await loadCaseSubject(id);
    const before = loadCaseSubjectIdentityProfile(id)?.anchors?.phrases?.length ?? 0;
    /*
     * Структура статьи — Викиданные — спрашивается для одной выбранной
     * карточки, а не для всех кандидатов панели (шаг 0093). Офлайн-контур в
     * сеть не ходит; отказ источника решение не отменяет — остаётся запас по
     * прозе лида.
     */
    const article = selectedCard.source === "wikipedia" ? selectedCard.articles[0] : undefined;
    const structured =
      article && String(process.env.NETWORK_CALLS ?? "") !== "0"
        ? await wikipediaProvider.structuredFacts({ language: article.language, title: article.title })
        : null;
    cardStructured = Boolean(structured && (structured.facts.length > 0 || structured.birthDate));
    const updated = applyCardAnchorsToProfile({
      caseId: id,
      subjectName: subject.fullName,
      subjectAliases: subject.aliases,
      subjectDateOfBirth: subject.dateOfBirth,
      card: selectedCard,
      structured,
    });
    cardAnchorPhrases = Math.max(0, (updated?.profile.anchors?.phrases.length ?? before) - before);
    cardBirthDateMismatch = updated?.birthDateMismatch ?? null;
  }

  await recordAudit({
    caseId: id,
    action: "PERSONA_DECIDED",
    actorId: user.id,
    metadata: {
      checkId: row.id,
      decision: row.decision,
      selectedCardId,
      // Сколько признаков приехало из карточки: по журналу видно, чем размечен
      // прогон — словами оператора или словами подтверждённого источника.
      cardAnchorPhrases,
      // Откуда признаки: из структуры статьи (Викиданные) или из прозы лида;
      // расхождение даты карточки с датой дела — тоже в журнал, а не в профиль.
      cardStructured,
      ...(cardBirthDateMismatch ? { cardBirthDateMismatch } : {}),
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
    cardAnchorPhrases,
  });
});
