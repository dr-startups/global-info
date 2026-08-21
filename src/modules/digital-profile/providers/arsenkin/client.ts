/**
 * Low-level ARSENKIN TOOLS HTTP client.
 * Protocol only: set / check / get / limits. No LLM. Token never logged.
 */

import { createHash } from "node:crypto";
import { createArsenkinRateLimiter, type RateLimiter } from "./rate-limit";
import { redactSecrets } from "./redact";
import { noteArsenkinNetworkCall } from "./network-guard";
import {
  assertLiveNetworkAllowed,
  assertLiveSetAllowed,
  getActiveLiveAuthorization,
} from "./live-execution-authorization";
import type {
  ArsenkinCheckTaskResponse,
  ArsenkinClientOptions,
  ArsenkinGetTaskResponse,
  ArsenkinLimitsResponse,
  ArsenkinSetTaskRequest,
  ArsenkinSetTaskResponse,
  ArsenkinTaskState,
} from "./types";

export const ARSENKIN_DEFAULT_API_BASE = "https://arsenkin.ru/api/tools";
const DEFAULT_BASE = ARSENKIN_DEFAULT_API_BASE;

export class ArsenkinRequestError extends Error {
  constructor(
    message: string,
    readonly options: { status?: number; code?: string; uncertain?: boolean; raw?: unknown } = {}
  ) {
    super(message);
    this.name = "ArsenkinRequestError";
  }
}

function sleepDefault(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function taskIdOf(raw: Record<string, unknown>): string {
  const id = raw.task_id ?? raw.taskId ?? raw.id;
  return id == null ? "" : String(id);
}

/**
 * Ответ `/check` → состояние задачи.
 *
 * Здесь **никогда** не возвращается `QUEUED`. В этой модели `QUEUED` значит
 * ровно одно: «строка заведена у нас, в Arsenkin ещё не отправлена» — так её
 * заводит `upsertPending`, и по ней же отправка выбирает работу. Очередь на
 * стороне Arsenkin (у аккаунта 5 одновременных задач при очереди на 50) — это
 * не «не отправлена», а «отправлена и ещё не готова», то есть `RUNNING`.
 *
 * Разница стоила прогона: раньше ответ «в очереди» записывался как `QUEUED`,
 * опрос считал такую строку неотправленной и переставал её опрашивать — задача
 * не доходила до `DONE` никогда.
 */
function mapCheckState(raw: Record<string, unknown>): ArsenkinTaskState {
  const blob = JSON.stringify(raw).toLowerCase();
  if (raw.code === "429" || /too many requests/.test(blob)) return "RATE_LIMITED";
  if (/fail|error|cancel/.test(blob) && /task/.test(blob) && !/result/.test(blob)) {
    if (/cancel/.test(blob)) return "CANCELLED";
    if (/fail|error/.test(blob) && (raw.status === "Error" || raw.error)) return "FAILED";
  }
  const status = String(raw.status ?? raw.state ?? raw.code ?? "").toLowerCase();
  /*
   * `finish` — наблюдённое слово завершения (живой прогон 20.08,
   * `{"code":"TASK_STATUS","status":"finish","progress":100}`).
   *
   * Раньше такое тело доходило до готовности окольно, через `progress >= 100`
   * ниже. Ответ выходил верным, но вторым путём: пропади `progress` из тела —
   * и завершённая задача читалась бы как «ещё считается» до конца бюджета
   * ожидания. Проверка идёт по началу слова, чтобы `unfinished` под неё не
   * попал.
   */
  if (
    status.includes("done") ||
    status.includes("ready") ||
    /^finish/u.test(status) ||
    status === "task_result"
  ) {
    return "DONE";
  }
  // Результат уже в ответе `/check` — ждать больше нечего.
  if (raw.result != null || raw.code === "TASK_RESULT") return "DONE";
  const progress = Number(raw.progress ?? raw.percent ?? NaN);
  if (Number.isFinite(progress) && progress >= 100) return "DONE";
  // Всё остальное — «Arsenkin взял задачу и ещё не отдал результат»: очередь,
  // работа, неизвестная нам форма ответа. Во всех этих случаях верно одно и то
  // же действие — опросить снова.
  return "RUNNING";
}

/**
 * Узнали ли мы форму ответа `/check`.
 *
 * Документация Arsenkin тел ответа не приводит, поэтому неизвестная форма не
 * роняет опрос (ждать дальше — безопасное поведение), но и не проходит молча:
 * её видно в логе строкой `arsenkin_check_shape_unknown`. Это и есть способ
 * однажды записать контракт по факту.
 *
 * Наблюдённые тела лежат рядом фикстурами и в коде не читаются — они
 * документация, и происхождение у них одно, живой прогон:
 *
 * - `check-pending.json` — `{"code":"TASK_STATUS","status":"process","progress":5,…}`;
 * - `check-done.json` — `{"code":"TASK_STATUS","status":"finish","progress":100,…}`,
 *   наблюдено 20.08. До этого файл содержал `{"status":"done","progress":100}` —
 *   форму, которой у провайдера нет.
 *
 * **Форма отказа не наблюдалась ни разу и здесь не выдумана.** Тело, которого
 * мы не знаем, читается как `RUNNING`; ожидание ограничено `maxWaitMs` шага, а
 * не числом попыток, поэтому такой ответ стоит времени, но не вечности.
 */
export function isRecognizedCheckShape(raw: Record<string, unknown>): boolean {
  if (raw.result != null) return true;
  const status = String(raw.status ?? raw.state ?? raw.code ?? "").toLowerCase();
  if (!status) return false;
  return /done|ready|result|queue|wait|run|work|process|progress|error|cancel|fail|finish|task_status/.test(
    status
  );
}

export function hashArsenkinRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
}

export class ArsenkinClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly limiter: RateLimiter;
  /** Per-request HTTP timeout; must stay below account lease TTL. */
  private readonly httpTimeoutMs: number;
  private readonly skipLiveAuthorizationCheck: boolean;

  constructor(options: ArsenkinClientOptions) {
    if (!options.token?.trim()) {
      throw new Error("ArsenkinClient requires API token");
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/$/, "");
    this.token = options.token.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 4;
    this.sleep = options.sleep ?? sleepDefault;
    this.httpTimeoutMs = Math.max(
      1_000,
      Number(options.httpTimeoutMs ?? process.env.ARSENKIN_HTTP_TIMEOUT_MS ?? 25_000) || 25_000
    );
    this.limiter = createArsenkinRateLimiter(options.requestsPerMinute ?? 30, {
      now: options.now,
      sleep: this.sleep,
    });
    this.skipLiveAuthorizationCheck = Boolean(options.skipLiveAuthorizationCheck);
  }

  async setTask(request: ArsenkinSetTaskRequest): Promise<ArsenkinSetTaskResponse> {
    if (!this.skipLiveAuthorizationCheck) {
      const auth = getActiveLiveAuthorization();
      if (!auth) {
        throw new Error("arsenkin-live-set-blocked:no-live-authorization");
      }
      assertLiveSetAllowed({
        reportRunId: auth.reportRunId,
        requestJson: request,
        countsAsNewTask: true,
        estimatedLimits: 1,
        allowUnknownCost: false,
      });
    }
    // A transport error after POST may still have created a task: never retry it.
    const raw = await this.postJson(`${this.baseUrl}/set`, request, { retryAmbiguousNetwork: false });
    const task_id = taskIdOf(raw);
    if (!task_id) {
      throw new Error(`Arsenkin setTask: missing task_id (${redactSecrets(JSON.stringify(raw).slice(0, 200))})`);
    }
    return { task_id, raw };
  }

  async checkTask(taskId: string | number): Promise<ArsenkinCheckTaskResponse> {
    const raw = await this.postJson(`${this.baseUrl}/check`, { task_id: taskId }, { retryAmbiguousNetwork: true });
    const id = taskIdOf(raw) || String(taskId);
    const state = mapCheckState(raw);
    if (!isRecognizedCheckShape(raw)) {
      // Не ошибка: опрос продолжается. Но форму надо увидеть — контракт `/check`
      // в документации не описан, и это единственный способ узнать его точно.
      console.info(
        JSON.stringify({
          event: "arsenkin_check_shape_unknown",
          externalTaskId: id,
          assumedState: state,
          payload: redactSecrets(JSON.stringify(raw).slice(0, 400)),
        })
      );
    }
    return {
      task_id: id,
      state,
      statusPayload: raw,
      raw,
    };
  }

  async getTask(taskId: string | number): Promise<ArsenkinGetTaskResponse> {
    const raw = await this.postJson(`${this.baseUrl}/get`, { task_id: taskId }, { retryAmbiguousNetwork: true });
    return {
      task_id: taskIdOf(raw) || String(taskId),
      code: raw.code != null ? String(raw.code) : undefined,
      result: raw.result ?? raw,
      raw,
    };
  }

  async getLimits(): Promise<ArsenkinLimitsResponse> {
    const raw = await this.postJson(`${this.baseUrl}/info`, { query: "limits" }, { retryAmbiguousNetwork: true });
    const limitsTotal = num(raw.limits_total ?? raw.limitsTotal);
    const limitsSpent = num(raw.limits_spent ?? raw.limitsSpent);
    const limitsLeft =
      num(raw.limits_left ?? raw.limitsLeft) ??
      (limitsTotal != null && limitsSpent != null ? limitsTotal - limitsSpent : undefined);
    return { limitsTotal, limitsSpent, limitsLeft, raw };
  }

  /**
   * Provider queue/status probe. Official contract: POST /api/tools/info { query: "status" }.
   * Never deletes foreign tasks. Used only to wait when account queue is saturated.
   */
  async getQueueStatus(): Promise<{
    activeTasks: number | null;
    queueSize: number | null;
    raw: Record<string, unknown>;
  }> {
    const raw = await this.postJson(`${this.baseUrl}/info`, { query: "status" }, { retryAmbiguousNetwork: true });
    const active =
      num(raw.active_tasks ?? raw.activeTasks ?? raw.running ?? raw.in_progress) ?? null;
    const queue =
      num(raw.queue_size ?? raw.queueSize ?? raw.queued ?? raw.in_queue) ?? null;
    return { activeTasks: active, queueSize: queue, raw };
  }

  /** Configured Arsenkin API base URL (no secrets) — for poll-auth binding. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /** Transport contract constants for tests / diagnostics. */
  static readonly TRANSPORT = {
    method: "POST" as const,
    setPath: "/set",
    checkPath: "/check",
    getPath: "/get",
    infoPath: "/info",
    checkBody: (taskId: string | number) => ({ task_id: taskId }),
    getBody: (taskId: string | number) => ({ task_id: taskId }),
  };

  /** Poll until DONE/FAILED or timeout. Uses exponential backoff + jitter. */
  async waitUntilDone(
    taskId: string | number,
    options?: { timeoutMs?: number; initialDelayMs?: number }
  ): Promise<ArsenkinCheckTaskResponse> {
    const timeoutMs = options?.timeoutMs ?? 10 * 60_000;
    const start = Date.now();
    let delay = options?.initialDelayMs ?? 1500;
    for (;;) {
      const check = await this.checkTask(taskId);
      if (check.state === "DONE" || check.state === "FAILED" || check.state === "CANCELLED") {
        return check;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`Arsenkin waitUntilDone timeout for task ${taskId}`);
      }
      const jitter = Math.floor(Math.random() * 400);
      await this.sleep(delay + jitter);
      delay = Math.min(15_000, Math.floor(delay * 1.6));
    }
  }

  private async postJson(
    url: string,
    body: unknown,
    options: { retryAmbiguousNetwork: boolean }
  ): Promise<Record<string, unknown>> {
    const kind = url.includes("/set")
      ? "set"
      : url.includes("/check")
        ? "check"
        : url.includes("/get")
          ? "get"
          : "info";
    if (!this.skipLiveAuthorizationCheck) {
      const bodyObj =
        body && typeof body === "object" && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : null;
      const rawTaskId = bodyObj?.task_id ?? bodyObj?.taskId ?? null;
      const taskId =
        typeof rawTaskId === "string" || typeof rawTaskId === "number" ? rawTaskId : null;
      assertLiveNetworkAllowed(kind, { taskId, requestUrl: url });
    }
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      noteArsenkinNetworkCall(kind);
      await this.limiter.acquire();
      try {
        const res = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.httpTimeoutMs),
        });
        const text = await res.text();
        let parsed: unknown = {};
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          parsed = { rawText: text.slice(0, 500) };
        }
        const obj = asObj(parsed);
        if (res.status === 429 || obj.code === "429" || obj.code === 429) {
          // /set must not blind-retry POST; check/get may wait and retry.
          if (!options.retryAmbiguousNetwork) {
            throw new ArsenkinRequestError("Arsenkin rate limited (429)", {
              status: 429,
              code: "429",
              raw: obj,
            });
          }
          const retryAfterMs = 2000 * (attempt + 1) + Math.floor(Math.random() * 500);
          await this.sleep(retryAfterMs);
          lastErr = new Error("Arsenkin rate limited (429)");
          continue;
        }
        if (!res.ok) {
          throw new ArsenkinRequestError(
            `Arsenkin HTTP ${res.status}: ${redactSecrets(text).slice(0, 240)}`,
            {
              status: res.status,
              code: obj.code != null ? String(obj.code) : undefined,
              raw: obj,
              // POST /set may have been accepted server-side despite a 5xx response.
              uncertain: res.status >= 500,
            }
          );
        }
        return obj;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const isAbort =
          (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) ||
          /aborted|timeout/i.test(String((err as Error)?.message ?? err));
        if (isAbort) {
          // /set timeout → SUBMIT_UNKNOWN (no blind retry). check/get may retry.
          if (!options.retryAmbiguousNetwork) {
            throw new ArsenkinRequestError(`Arsenkin HTTP timeout after ${this.httpTimeoutMs}ms`, {
              code: "http_timeout",
              uncertain: true,
            });
          }
          lastErr = new ArsenkinRequestError(`Arsenkin HTTP timeout after ${this.httpTimeoutMs}ms`, {
            code: "http_timeout",
          });
          if (attempt >= this.maxRetries) break;
          await this.sleep(500 * (attempt + 1));
          continue;
        }
        if (err instanceof ArsenkinRequestError && err.options.status && err.options.status !== 429) {
          throw err;
        }
        if (err instanceof ArsenkinRequestError && err.options.status === 429 && !options.retryAmbiguousNetwork) {
          throw err;
        }
        if (!options.retryAmbiguousNetwork) {
          throw new ArsenkinRequestError(lastErr.message, { uncertain: true });
        }
        if (attempt >= this.maxRetries) break;
        await this.sleep(500 * (attempt + 1));
      }
    }
    throw lastErr ?? new Error("Arsenkin request failed");
  }
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function createArsenkinClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides?: Partial<ArsenkinClientOptions>
): ArsenkinClient | null {
  const token = String(env.ARSENKIN_API_TOKEN ?? "").trim();
  if (!token) return null;
  return new ArsenkinClient({
    token,
    baseUrl: env.ARSENKIN_API_BASE_URL?.trim() || undefined,
    requestsPerMinute: Number(env.ARSENKIN_REQUESTS_PER_MINUTE ?? 30) || 30,
    // Env clients always enforce live authorization (caller may not override to skip).
    ...overrides,
    skipLiveAuthorizationCheck: false,
  });
}
