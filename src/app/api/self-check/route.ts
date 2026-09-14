/**
 * POST /api/self-check — создать проверку с сайта.
 *
 * Единственная публичная ручка без cookie: она её и выдаёт. Тот же браузер с
 * теми же данными получает прежнюю проверку (`existingPublicId`), а не новую.
 */

import type { NextRequest } from "next/server";
import { jsonOk } from "@/modules/digital-profile/http/errors";
import { readCookie, readJsonBody } from "@/modules/digital-profile/http/request";
import { createSelfCheck } from "@/modules/self-check/service";
import {
  clientIp,
  setSelfCheckCookie,
  userAgentOf,
  withSelfCheck,
} from "@/modules/self-check/http";
import { SELF_CHECK_COOKIE } from "@/modules/self-check/token";

export const dynamic = "force-dynamic";

export const POST = withSelfCheck(async (req: NextRequest) => {
  const body = await readJsonBody(req);
  const result = await createSelfCheck({
    body,
    ip: clientIp(req),
    userAgent: userAgentOf(req),
    cookieToken: readCookie(req, SELF_CHECK_COOKIE),
  });
  if (result.kind === "existing") {
    return jsonOk({ existingPublicId: result.existingPublicId });
  }
  const res = jsonOk({ publicId: result.publicId, status: result.status }, 201);
  setSelfCheckCookie(res, result.token);
  return res;
});
