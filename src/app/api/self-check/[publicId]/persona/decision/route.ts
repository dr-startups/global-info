/**
 * POST /api/self-check/[publicId]/persona/decision — «Это я» или «Среди них
 * меня нет». Тело: `{ decision, selectedCardId? }`.
 */

import type { NextRequest } from "next/server";
import { jsonOk } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import { clientIp, requireSelfCheck, withSelfCheck } from "@/modules/self-check/http";
import { decideSelfCheckPersona } from "@/modules/self-check/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

export const POST = withSelfCheck(async (req: NextRequest, ctx: RouteContext) => {
  const { publicId } = await ctx.params;
  const check = await requireSelfCheck(req, publicId);
  const body = await readJsonBody(req);
  return jsonOk(await decideSelfCheckPersona(check, body, { ip: clientIp(req) }));
});
