/**
 * POST /api/self-check/[publicId]/run — запуск лёгкого прогона.
 *
 * Запуск принимает работу и отвечает `202`: прогон идёт минуты, и результат
 * посетитель узнаёт опросом статуса. Решение по персоне, повторный запуск и
 * ловушка — отказы сервиса запуска; рубильник и cookie — обёртки и гарда, до
 * всякой работы.
 */

import type { NextRequest } from "next/server";
import { jsonOk } from "@/modules/digital-profile/http/errors";
import { clientIp, requireSelfCheck, withSelfCheck } from "@/modules/self-check/http";
import { startSelfCheckRun } from "@/modules/self-check/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

export const POST = withSelfCheck(async (req: NextRequest, ctx: RouteContext) => {
  const { publicId } = await ctx.params;
  const check = await requireSelfCheck(req, publicId);
  return jsonOk(await startSelfCheckRun(check, { ip: clientIp(req) }), 202);
});
