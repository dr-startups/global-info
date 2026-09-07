/**
 * GET  /api/digital-profile/cases/[id]/orion-golden/manual-review/[evidenceId]
 *   — карточка материала классической очереди; читать её можно по-прежнему.
 * POST — отказывает: решения принимаются во вкладке «Проверка перед выпуском».
 *
 * Классическая очередь писала решения в файл на томе, вкладка — в таблицу
 * решений. Пока писали оба, у продукта было два ответа на «что решил аналитик»,
 * и разойтись им предстояло в первый же день: у файла нет ни истории, ни
 * автора, ни отпечатка набора, по которому видно, что документ собран раньше
 * решения.
 *
 * Прежние решения из файла при этом не теряются: канонический конвейер их
 * читает и применяет — они слабее решений таблицы, потому что применяются
 * раньше.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule } from "@/modules/digital-profile/http/errors";
import {
  assertCanReviewEvidence,
  requireOrionAdminApiAccess,
} from "@/modules/digital-profile/orion-golden/auth/orion-admin-auth";
import {
  classicQueueDecisionRefusal,
  getManualReviewItem,
} from "@/modules/digital-profile/orion-golden/services/admin-review-workflow-service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; evidenceId: string }> };

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id, evidenceId } = await ctx.params;
  await requireOrionAdminApiAccess(req, id, "view");
  const data = getManualReviewItem(id, evidenceId);
  return jsonOk(data);
});

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireOrionAdminApiAccess(req, id, "review");
  // Права проверяются до отказа намеренно: посторонний не должен узнавать из
  // ответа даже того, что такое дело существует.
  assertCanReviewEvidence(user);
  throw classicQueueDecisionRefusal();
});
