/**
 * POST /api/digital-profile/cases/[id]/unified-collection/release
 *
 * Выпуск отчёта: та же пересборка, что и «Пересобрать отчёт», но с запросом
 * выпуска на джобе — успешная сборка пометит документ выпуском и запишет его
 * хеш. Платных вызовов нет: путь тот же, что у пересборки.
 *
 * Пометить выпуском уже готовый файл нельзя намеренно: он собран до последних
 * решений аналитика.
 */

import type { NextRequest } from "next/server";
import { jsonOk, withModule, ValidationError } from "@/modules/digital-profile/http/errors";
import {
  actorOf,
  requireCaseAccess,
  requireDigitalProfileUser,
  requireRole,
} from "@/modules/digital-profile/auth/guard";
import { rebuildUnifiedReport } from "@/modules/digital-profile/services/unified-report-rebuild";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  const user = await requireDigitalProfileUser(req);
  requireRole(user, "report.release");
  await requireCaseAccess(user, id, "VIEWER");

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const jobId = String(body.jobId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");

  const actor = actorOf(user);
  const data = await rebuildUnifiedReport({
    caseId: id,
    jobId,
    actorId: actor.actorId ?? user.id,
    requestRelease: true,
  });
  return jsonOk(data, 202);
});
