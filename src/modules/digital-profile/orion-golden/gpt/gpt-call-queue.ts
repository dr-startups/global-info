/**
 * REMEDIATION §4.2 — GPT call queue with concurrency, retries and stage deadline.
 *
 * Retries for 429/5xx/timeout live here (not in openai-json-client). Results are
 * returned in the same order as input tasks; callers that need deterministic
 * application should still sort by a stable key before writing artifacts.
 */

export type GptCallFailureReason = "FALLBACK_TIMEOUT" | "FALLBACK_ERROR";

export type GptQueueTaskResult<T> =
  | { key: string; ok: true; value: T; attempts: number }
  | { key: string; ok: false; error: Error; reason: GptCallFailureReason; attempts: number };

export type GptCallQueueOptions = {
  /** Max in-flight calls (env ORION_GPT_CONCURRENCY, default 2). */
  concurrency?: number;
  /** Attempts per task including the first (default 5). */
  maxAttempts?: number;
  /** Global stage deadline in ms (env ORION_GPT_STAGE_DEADLINE_MS, default 10 min). */
  deadlineMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class OpenAiCallError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    opts: { retryable: boolean; status?: number; retryAfterMs?: number } = {
      retryable: false,
    }
  ) {
    super(message);
    this.name = "OpenAiCallError";
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Classify transport/API failures for the queue. */
export function classifyOpenAiError(err: unknown): {
  retryable: boolean;
  retryAfterMs?: number;
  status?: number;
} {
  if (err instanceof OpenAiCallError) {
    return {
      retryable: err.retryable,
      retryAfterMs: err.retryAfterMs,
      status: err.status,
    };
  }
  const msg = err instanceof Error ? err.message : String(err);
  const statusMatch = msg.match(/openai-http-(\d{3})/i);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  if (status === 429 || (status != null && status >= 500)) {
    return { retryable: true, status };
  }
  if (/openai-429|rate.?limit|BLOCKED_OPENAI_RATE_LIMIT/i.test(msg)) {
    return { retryable: true, status: 429 };
  }
  if (/abort|timeout|etimedout|econnreset|fetch failed|network/i.test(msg)) {
    return { retryable: true };
  }
  return { retryable: false, status };
}

function backoffMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs != null && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.min(60_000, Math.floor(retryAfterMs));
  }
  // 1s → 2s → 4s → 8s (attempt is 1-based after a failure)
  return Math.min(8_000, 1000 * 2 ** Math.max(0, attempt - 1));
}

function readRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const asInt = Number(header);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt * 1000;
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

export function retryAfterMsFromResponse(res: {
  headers?: { get?: (name: string) => string | null };
}): number | undefined {
  return readRetryAfterMs(res.headers?.get?.("retry-after") ?? null);
}

export function defaultGptCallQueueOptions(
  env: NodeJS.ProcessEnv = process.env
): Required<Pick<GptCallQueueOptions, "concurrency" | "maxAttempts" | "deadlineMs">> {
  const concurrency = Math.max(1, Number(env.ORION_GPT_CONCURRENCY ?? 2) || 2);
  const deadlineMs = Math.max(
    1_000,
    // 15 минут: на замеренных прогонах стадия текста укладывается, а прежние
    // 10 обрывали её на больших делах.
    Number(env.ORION_GPT_STAGE_DEADLINE_MS ?? 900_000) || 900_000
  );
  return { concurrency, maxAttempts: 5, deadlineMs };
}

/**
 * Run tasks with limited concurrency and per-task exponential backoff.
 * Tasks that cannot start before the deadline fail with FALLBACK_TIMEOUT.
 */
export async function runGptCallQueue<T>(input: {
  tasks: Array<{ key: string; run: () => Promise<T> }>;
  options?: GptCallQueueOptions;
}): Promise<Array<GptQueueTaskResult<T>>> {
  const defaults = defaultGptCallQueueOptions();
  const concurrency = Math.max(1, input.options?.concurrency ?? defaults.concurrency);
  const maxAttempts = Math.max(1, input.options?.maxAttempts ?? defaults.maxAttempts);
  const deadlineMs = input.options?.deadlineMs ?? defaults.deadlineMs;
  const now = input.options?.now ?? Date.now;
  const sleep =
    input.options?.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const startedAt = now();

  const results = new Map<string, GptQueueTaskResult<T>>();
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor;
      cursor += 1;
      if (idx >= input.tasks.length) return;
      const task = input.tasks[idx]!;

      if (now() - startedAt >= deadlineMs) {
        results.set(task.key, {
          key: task.key,
          ok: false,
          error: new Error("gpt-stage-deadline-exceeded"),
          reason: "FALLBACK_TIMEOUT",
          attempts: 0,
        });
        continue;
      }

      let attempts = 0;
      let lastError: Error = new Error("gpt-call-failed");
      let done = false;
      while (attempts < maxAttempts) {
        if (now() - startedAt >= deadlineMs) {
          results.set(task.key, {
            key: task.key,
            ok: false,
            error: new Error("gpt-stage-deadline-exceeded"),
            reason: "FALLBACK_TIMEOUT",
            attempts,
          });
          done = true;
          break;
        }
        attempts += 1;
        try {
          const value = await task.run();
          results.set(task.key, { key: task.key, ok: true, value, attempts });
          done = true;
          break;
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          const classified = classifyOpenAiError(err);
          if (!classified.retryable || attempts >= maxAttempts) break;
          const wait = backoffMs(attempts, classified.retryAfterMs);
          const remaining = deadlineMs - (now() - startedAt);
          if (wait > remaining) {
            results.set(task.key, {
              key: task.key,
              ok: false,
              error: new Error("gpt-stage-deadline-exceeded"),
              reason: "FALLBACK_TIMEOUT",
              attempts,
            });
            done = true;
            break;
          }
          await sleep(wait);
        }
      }
      if (!done) {
        results.set(task.key, {
          key: task.key,
          ok: false,
          error: lastError,
          reason: "FALLBACK_ERROR",
          attempts,
        });
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, input.tasks.length) }, () =>
    worker()
  );
  if (workers.length === 0) return [];
  await Promise.all(workers);

  return input.tasks.map((t) => {
    const r = results.get(t.key);
    if (r) return r;
    return {
      key: t.key,
      ok: false as const,
      error: new Error("gpt-queue-missing-result"),
      reason: "FALLBACK_ERROR" as const,
      attempts: 0,
    };
  });
}
