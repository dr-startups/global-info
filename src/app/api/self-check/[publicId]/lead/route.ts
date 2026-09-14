/**
 * POST /api/self-check/[publicId]/lead — заявка посетителя.
 * Тело: `{ name, phone?, email?, telegram?, preferredTime?, message? }`, хотя бы
 * один контакт. Повторная отправка заменяет контакты.
 */

import type { NextRequest } from "next/server";
import { jsonOk } from "@/modules/digital-profile/http/errors";
import { readJsonBody } from "@/modules/digital-profile/http/request";
import { clientIp, requireSelfCheck, withSelfCheck } from "@/modules/self-check/http";
import { submitSelfCheckLead } from "@/modules/self-check/service";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ publicId: string }> };

export const POST = withSelfCheck(async (req: NextRequest, ctx: RouteContext) => {
  const { publicId } = await ctx.params;
  const check = await requireSelfCheck(req, publicId);
  const body = await readJsonBody(req);
  return jsonOk(await submitSelfCheckLead(check, body, { ip: clientIp(req) }));
});
