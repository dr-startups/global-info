/**
 * POST /api/digital-profile/cases/[id]/unified-collection/pause
 *
 * Просит идущий прогон остановиться. Останавливает не ручка: она поднимает
 * признак, а переводит джобу в `CANCELLED` ближайший тик — так пауза не
 * обрывает шаг посередине и не спорит с лизой.
 *
 * Пауза — не отмена: собранное остаётся, прогон возобновляется с места
 * остановки, и отчёт из уже собранного собрать можно (решение владельца 21.08).
 * Денег ручка не тратит, поэтому права `agents.runReal` она не требует.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule, ValidationError } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { pauseUnifiedCollectionRun } from "@/modules/digital-profile/services/unified-collection-pause";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "agents.run");
  await requireCaseAccess(user, id, "EDITOR");

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const jobId = String(body.jobId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");

  const actor = actorOf(user);
  const data = await pauseUnifiedCollectionRun({
    caseId: id,
    jobId,
    actorId: actor.actorId ?? user.id,
  });
  return jsonOk(data, 202);
});
