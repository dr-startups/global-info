/**
 * Обёртка и гард публичных ручек проверки.
 *
 * Публичный API защищает себя сам: middleware закрывает только админку. Каждая
 * ручка проходит рубильник, каждый ответ — и отказ тоже — не кэшируется и не
 * индексируется, а всё, кроме создания, открывает только cookie своей проверки.
 */

import { NextResponse } from "next/server";
import type { SelfCheck } from "@prisma/client";
import { AppError, NotFoundError, withModule } from "@/modules/digital-profile/http/errors";
import { readCookie } from "@/modules/digital-profile/http/request";
import { boolSetting } from "@/modules/digital-profile/config/defaults";
import { loadSelfCheckByPublicId } from "./service";
import {
  SELF_CHECK_COOKIE,
  SELF_CHECK_COOKIE_PATH,
  selfCheckSecret,
  selfCheckTokenTtlSeconds,
  verifySelfCheckToken,
} from "./token";

export function withSelfCheck<A extends unknown[]>(
  handler: (...args: A) => Promise<NextResponse>
): (...args: A) => Promise<NextResponse> {
  const wrapped = withModule(async (...args: A) => {
    if (!boolSetting("SELF_CHECK_ENABLED")) {
      throw new AppError("MODULE_DISABLED", 503, "Self-check is temporarily disabled", {
        reason: "SELF_CHECK_DISABLED",
      });
    }
    return handler(...args);
  });
  return async (...args: A) => {
    const res = await wrapped(...args);
    res.headers.set("cache-control", "no-store");
    res.headers.set("x-robots-tag", "noindex");
    return res;
  };
}

/**
 * Проверка из адреса, открытая cookie этого браузера.
 *
 * Обезличенная запись отвечает `410` раньше проверки cookie: срок cookie равен
 * сроку хранения, и к обезличиванию она тоже истекла — человек должен прочесть
 * «срок истёк», а не «откройте в том же браузере». Разница `404` и `403`
 * существования записи не выдаёт: `publicId` не угадать.
 */
export async function requireSelfCheck(req: Request, publicId: string): Promise<SelfCheck> {
  const check = await loadSelfCheckByPublicId(publicId);
  if (!check) throw new NotFoundError("Self-check not found");
  if (check.anonymizedAt) {
    throw new AppError("NOT_FOUND", 410, "Self-check has expired", { reason: "SELF_CHECK_EXPIRED" });
  }
  const token = await verifySelfCheckToken(readCookie(req, SELF_CHECK_COOKIE), selfCheckSecret());
  if (!token || token.checkId !== check.id) {
    throw new AppError("FORBIDDEN", 403, "Open the check in the browser where it was started", {
      reason: "SELF_CHECK_FORBIDDEN",
    });
  }
  return check;
}

/**
 * Адрес посетителя — первый элемент `x-forwarded-for`, как его ставит прокси
 * площадки. Без прокси (локальный стенд) заголовка нет, и все посетители — один
 * адрес `unknown`.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  const real = req.headers.get("x-real-ip")?.trim();
  return real ? real.slice(0, 64) : "unknown";
}

export function userAgentOf(req: Request): string {
  return (req.headers.get("user-agent") ?? "").slice(0, 500);
}

export function setSelfCheckCookie(res: NextResponse, token: string): void {
  res.cookies.set(SELF_CHECK_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: SELF_CHECK_COOKIE_PATH,
    maxAge: selfCheckTokenTtlSeconds(),
  });
}
