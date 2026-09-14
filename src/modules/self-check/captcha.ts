/**
 * Проверка Yandex SmartCaptcha на публичной форме.
 *
 * Каждая проверка стоит денег, и капча — первая мера расхода. Площадка без
 * серверного ключа не пропускает никого: иначе забытая переменная открыла бы
 * форму ботам молча. Локальный стенд пропускает с предупреждением, чтобы
 * разработка не требовала ключа.
 *
 * Ответ сервиса с кодом не 200 и недоступность сервиса — пропуск: так советует
 * документация Яндекса, чтобы чужая авария не задерживала людей. Расход в
 * такие минуты держат лимиты по адресу и суточный потолок прогонов.
 */

import { AppError, ValidationError } from "@/modules/digital-profile/http/errors";
import { isDeployLikeEnvironment } from "@/modules/digital-profile/auth/auth-config";

export const SMARTCAPTCHA_VALIDATE_URL = "https://smartcaptcha.cloud.yandex.ru/validate";

const VALIDATE_TIMEOUT_MS = 5_000;

export type CaptchaOutcome =
  | { verified: true }
  | { verified: false; skipped: "NOT_CONFIGURED" | "SERVICE_UNAVAILABLE" };

function captchaFailed(): ValidationError {
  return new ValidationError("Captcha verification failed", { reason: "CAPTCHA_FAILED" });
}

export async function verifyCaptcha(input: {
  token?: string | null;
  ip: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<CaptchaOutcome> {
  const env = input.env ?? process.env;
  const secret = (env.SMARTCAPTCHA_SERVER_KEY ?? "").trim();
  if (!secret) {
    if (isDeployLikeEnvironment(env)) {
      throw new AppError("MODULE_DISABLED", 503, "Captcha is not configured", {
        reason: "CAPTCHA_NOT_CONFIGURED",
      });
    }
    console.warn("[self-check][captcha] SMARTCAPTCHA_SERVER_KEY не задан — капча пропущена (не площадка)");
    return { verified: false, skipped: "NOT_CONFIGURED" };
  }

  const token = String(input.token ?? "").trim();
  if (!token) throw captchaFailed();

  // Офлайн-контуру проверить токен нечем, а пропустить его молча значило бы
  // сделать зелёным тест, который капчу не проверял.
  if (!input.fetchImpl && String(env.NETWORK_CALLS ?? "") === "0") throw captchaFailed();

  const form = new URLSearchParams({ secret, token });
  // Адрес сервис принимает необязательным; «unknown» — не адрес.
  if (input.ip && input.ip !== "unknown") form.set("ip", input.ip);

  let res: Response;
  try {
    res = await (input.fetchImpl ?? fetch)(SMARTCAPTCHA_VALIDATE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(
      `[self-check][captcha] сервис проверки недоступен — пропуск: ${err instanceof Error ? err.message : String(err)}`
    );
    return { verified: false, skipped: "SERVICE_UNAVAILABLE" };
  }
  if (res.status !== 200) {
    console.warn(`[self-check][captcha] сервис проверки ответил HTTP ${res.status} — пропуск`);
    return { verified: false, skipped: "SERVICE_UNAVAILABLE" };
  }

  let body: { status?: unknown } | null = null;
  try {
    body = (await res.json()) as { status?: unknown };
  } catch {
    body = null;
  }
  if (body?.status === "ok") return { verified: true };
  throw captchaFailed();
}
