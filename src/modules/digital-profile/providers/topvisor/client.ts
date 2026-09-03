/**
 * Клиент Topvisor API v2 — официальный HTTP, без обхода чего бы то ни было.
 *
 * Адрес собирается из действия и службы: `POST {BASE}/{action}/{service}` плюс
 * необязательный метод. Заголовки: `User-Id` и `Authorization: bearer <ключ>`.
 * Секреты в лог не попадают и в ответе не сохраняются — фикстуры проходят через
 * `redactSecrets`.
 *
 * Сеть отмечается общим сторожем провайдеров: вопрос «можно ли сейчас в сеть»
 * один на Arsenkin и Topvisor, и ответ на него один.
 *
 * Ошибка не бросается наружу сырой: у Topvisor «ошибка» приходит телом
 * `{"errors":[…]}` с кодом 200, и молча принять такой ответ за результат —
 * значит записать в отчёт пустую выдачу как настоящую.
 */

import { topvisorSecrets } from "../config";
import { noteProviderNetworkCall } from "../network-guard";

export const TOPVISOR_BASE = "https://api.topvisor.com/v2/json";

/** Предел аккаунта: пять одновременных обращений на IP и на `User-Id`. */
export const TOPVISOR_MAX_CONCURRENT = 5;

export type TopvisorCallInput = {
  /** `get`, `add`, `edit`, `del` — первая часть адреса. */
  action: string;
  /** `projects_2`, `positions_2`, `snapshots_2`, `keywords_2`, `system_2`. */
  service: string;
  /** Необязательный метод: `projects`, `history`, `checker/go`, … */
  method?: string;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
};

export type TopvisorCallResult<T = unknown> = {
  ok: boolean;
  httpStatus: number;
  /** Тело ответа как есть — в фикстуру уходит именно оно (после вычистки). */
  body: T;
  /** Ошибки, названные самим сервисом (`{"errors":[…]}` при коде 200). */
  errors: string[];
};

export class TopvisorNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(`Topvisor не настроен: нет ${missing.join(", ")}.`);
    this.name = "TopvisorNotConfiguredError";
  }
}

function errorsOf(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as { errors?: unknown }).errors;
  if (!Array.isArray(raw)) return [];
  return raw.map((e) =>
    typeof e === "string" ? e : String((e as { string?: unknown })?.string ?? JSON.stringify(e))
  );
}

/**
 * Один вызов Topvisor.
 *
 * `fetchImpl` подставляется тестами и пилотом: офлайн-контур обязан обходиться
 * без сети, а фикстуры пишутся тем же кодом, каким ходит рабочий путь.
 */
export async function topvisorCall<T = unknown>(
  input: TopvisorCallInput,
  deps: {
    fetchImpl?: typeof fetch;
    env?: NodeJS.ProcessEnv;
  } = {}
): Promise<TopvisorCallResult<T>> {
  const env = deps.env ?? process.env;
  const { apiKey, userId } = topvisorSecrets(env);
  const missing = [!apiKey ? "TOPVISOR_API_KEY" : null, !userId ? "TOPVISOR_USER_ID" : null].filter(
    (x): x is string => Boolean(x)
  );
  if (missing.length > 0) throw new TopvisorNotConfiguredError(missing);

  const url = [TOPVISOR_BASE, input.action, input.service, input.method]
    .filter((part) => String(part ?? "").length > 0)
    .join("/");

  noteProviderNetworkCall(`topvisor:${input.action}/${input.service}${input.method ? `/${input.method}` : ""}`, env);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 60_000);
  try {
    const response = await (deps.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Id": String(userId),
        Authorization: `bearer ${String(apiKey)}`,
      },
      body: JSON.stringify(input.payload ?? {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
    const errors = errorsOf(body);
    return {
      ok: response.ok && errors.length === 0,
      httpStatus: response.status,
      body: body as T,
      errors,
    };
  } finally {
    clearTimeout(timer);
  }
}
