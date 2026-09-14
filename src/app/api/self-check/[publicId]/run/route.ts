/**
 * POST /api/self-check/[publicId]/run — запуск лёгкого прогона.
 *
 * Лёгкого режима у конвейера ещё нет, поэтому ручка честно отвечает `503` со
 * своей причиной, а не запускает полный платный прогон вместо лёгкого. Cookie
 * проверяется и здесь: без неё о состоянии ручки не узнать.
 */

import type { NextRequest } from "next/server";
import { AppError } from "@/modules/digital-profile/http/errors";
import { requireSelfCheck, withSelfCheck } from "@/modules/self-check/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

export const POST = withSelfCheck(async (req: NextRequest, ctx: RouteContext) => {
  const { publicId } = await ctx.params;
  await requireSelfCheck(req, publicId);
  throw new AppError("MODULE_DISABLED", 503, "Light run is not available yet", {
    reason: "NOT_IMPLEMENTED_YET",
  });
});
