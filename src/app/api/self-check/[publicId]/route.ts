/**
 * GET /api/self-check/[publicId] — статус проверки для экрана посетителя.
 *
 * Отдаёт публичную проекцию, а не запись: ни связи с кейсом, ни адреса, ни
 * контактов заявки.
 */

import type { NextRequest } from "next/server";
import { jsonOk } from "@/modules/digital-profile/http/errors";
import { requireSelfCheck, withSelfCheck } from "@/modules/self-check/http";
import { getSelfCheckStatus } from "@/modules/self-check/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

export const GET = withSelfCheck(async (req: NextRequest, ctx: RouteContext) => {
  const { publicId } = await ctx.params;
  const check = await requireSelfCheck(req, publicId);
  return jsonOk(await getSelfCheckStatus(check));
});
