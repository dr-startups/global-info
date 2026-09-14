/**
 * Токен посетителя сайта: доступ к одной проверке без учётной записи.
 *
 * Тело `{ kind: "self-check", checkId, iat, exp }` подписано тем же примитивом
 * и тем же секретом, что сессия сотрудника. Различает их `kind`: сессия его не
 * принимает, а токен посетителя без него — не токен. Иначе токен посетителя, в
 * котором оказался бы `uid`, открыл бы админку.
 */

import { AppError } from "@/modules/digital-profile/http/errors";
import {
  DEFAULT_SESSION_SECRET,
  isDeployLikeEnvironment,
} from "@/modules/digital-profile/auth/auth-config";
import { numberSetting } from "@/modules/digital-profile/config/defaults";
import { readSignedToken, signToken } from "@/modules/digital-profile/auth/signed-token";

export const SELF_CHECK_COOKIE = "dp_selfcheck";

/**
 * Путь cookie — публичный API, и только он. Страница мастера данных сама не
 * читает: всё приходит через API, а лишний путь — лишнее место, куда cookie
 * уходит.
 */
export const SELF_CHECK_COOKIE_PATH = "/api/self-check";

export interface SelfCheckTokenPayload {
  kind: "self-check";
  checkId: string;
  iat: number;
  exp: number;
}

const MIN_SECRET_LENGTH = 16;

/**
 * Секрет подписи токена и хешей.
 *
 * На площадке секрет по умолчанию или короткий — отказ: значение по умолчанию
 * лежит в открытом коде, и токен любой проверки по нему подделывается. Вход в
 * админку проверяет секрет только при включённой авторизации, а публичной
 * проверке это условие не подходит — она открыта всегда.
 */
export function selfCheckSecret(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.DIGITAL_PROFILE_SESSION_SECRET ?? "").trim();
  const weak = raw.length < MIN_SECRET_LENGTH || raw === DEFAULT_SESSION_SECRET;
  if (weak && isDeployLikeEnvironment(env)) {
    throw new AppError("MODULE_DISABLED", 503, "Self-check signing secret is not configured", {
      reason: "SELF_CHECK_SECRET_NOT_CONFIGURED",
    });
  }
  return raw || DEFAULT_SESSION_SECRET;
}

export function selfCheckTokenTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  return numberSetting("SELF_CHECK_TOKEN_TTL_DAYS", env) * 24 * 60 * 60;
}

export async function createSelfCheckToken(
  checkId: string,
  secret: string,
  opts: { ttlSeconds?: number; now?: Date } = {}
): Promise<string> {
  const iat = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const payload: SelfCheckTokenPayload = {
    kind: "self-check",
    checkId,
    iat,
    exp: iat + (opts.ttlSeconds ?? selfCheckTokenTtlSeconds()),
  };
  return signToken(payload, secret);
}

/** Подпись, назначение и срок. `null` — токена этой проверки нет. */
export async function verifySelfCheckToken(
  token: string | undefined | null,
  secret: string,
  now: Date = new Date()
): Promise<SelfCheckTokenPayload | null> {
  const payload = await readSignedToken(token, secret);
  if (!payload || payload.kind !== "self-check") return null;
  const { checkId, iat, exp } = payload;
  if (typeof checkId !== "string" || !checkId) return null;
  if (typeof iat !== "number" || typeof exp !== "number") return null;
  if (exp < Math.floor(now.getTime() / 1000)) return null;
  return { kind: "self-check", checkId, iat, exp };
}
