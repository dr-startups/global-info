/**
 * POST /api/self-check/[publicId]/persona — панель «Это вы?».
 *
 * Собирает панель один раз; повторный вызов отдаёт собранную. Отказ всех
 * источников — не ошибка: карточек нет, а состояние каждого источника названо.
 */

import type { NextRequest } from "next/server";
import { jsonOk } from "@/modules/digital-profile/http/errors";
import { clientIp, requireSelfCheck, withSelfCheck } from "@/modules/self-check/http";
import { buildSelfCheckPersona } from "@/modules/self-check/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

export const POST = withSelfCheck(async (req: NextRequest, ctx: RouteContext) => {
  const { publicId } = await ctx.params;
  const check = await requireSelfCheck(req, publicId);
  return jsonOk(await buildSelfCheckPersona(check, { ip: clientIp(req) }));
});
