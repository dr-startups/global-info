/**
 * Решения аналитика по пунктам листа проверки.
 *
 *   GET  — все решения кейса, включая погашенные, плюс отпечаток действующих.
 *   POST — записать решение: прежнее по этой паре гасится и остаётся в истории.
 *
 * Ключ пункта — ключ материала: он содержит «/», «|» и «:», поэтому едет телом
 * запроса, а не сегментом пути. В отчёт решения попадают только пересборкой и
 * только результатом: ни имени аналитика, ни даты документ не печатает.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule, ValidationError } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";
import {
  activeReviewDecisions,
  isValidReviewDecision,
  listReviewDecisions,
  recordReviewDecision,
  reviewDecisionsDigest,
  type ReviewDecisionPrisma,
} from "@/modules/digital-profile/services/review-decision-store";
import { prisma } from "@/server/prisma/client";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

const ITEM_KINDS = new Set(["evidence", "finding", "compliance"]);

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "evidence.viewRaw");
  await requireCaseAccess(user, id, "VIEWER");

  const rows = await listReviewDecisions(id, prisma as unknown as ReviewDecisionPrisma);
  return jsonOk({
    decisions: rows,
    active: [...activeReviewDecisions(rows).values()],
    digest: reviewDecisionsDigest(rows),
  });
});

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  // Решение о материале — работа того, кто ведёт кейс.
  requireRole(user, "evidence.create");
  await requireCaseAccess(user, id, "EDITOR");

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const itemKind = String(body.itemKind ?? "").trim();
  const itemKey = String(body.itemKey ?? "").trim();
  const decisionKind = String(body.decisionKind ?? "").trim();
  const status = String(body.status ?? "").trim();
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 320) : null;

  if (!ITEM_KINDS.has(itemKind)) throw new ValidationError("itemKind is invalid");
  if (!itemKey) throw new ValidationError("itemKey is required");
  // Ответ не на свой вопрос молча не проходит: иначе «негатив» лёг бы в
  // принадлежность и не изменил бы ничего.
  if (!isValidReviewDecision(decisionKind, status)) {
    throw new ValidationError("decisionKind/status pair is invalid");
  }

  const actor = actorOf(user);
  const row = await recordReviewDecision(
    {
      caseId: id,
      itemKind,
      itemKey,
      decisionKind,
      status,
      note,
      decidedBy: actor.actorId ?? user.id,
    },
    prisma as unknown as ReviewDecisionPrisma
  );

  await recordAudit({
    caseId: id,
    action: "REVIEW_DECISION_RECORDED",
    actorId: user.id,
    metadata: { itemKind, itemKey, decisionKind, status },
  });

  const rows = await listReviewDecisions(id, prisma as unknown as ReviewDecisionPrisma);
  return jsonOk({ decision: row, digest: reviewDecisionsDigest(rows) }, 201);
});
