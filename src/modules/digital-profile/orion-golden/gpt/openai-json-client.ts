/**
 * R10 — OpenAI Responses API JSON helper (aligned with R9.7b GPT-5.5 client).
 *
 * REMEDIATION §4.2: this client performs a single HTTP attempt and classifies
 * failures. Retries / rate-limit backoff live in `gpt-call-queue.ts`.
 *
 * REMEDIATION §4.5: one adaptive retry when the response looks truncated
 * (incomplete / invalid JSON near max_output_tokens) with a doubled budget
 * (cap 32000).
 */

import { digitalProfileConfig } from "../../config";
import { OpenAiRateLimitError, isOpenAiHttp429 } from "./openai-rate-limit";
import {
  OpenAiCallError,
  retryAfterMsFromResponse,
  runGptCallQueue,
  defaultGptCallQueueOptions,
} from "./gpt-call-queue";

interface OpenAiResponseShape {
  status?: string;
  incomplete_details?: { reason?: string };
  usage?: { output_tokens?: number };
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

export type OpenAiJsonCallDiagnostics = {
  truncationRetry: boolean;
  firstMaxOutputTokens: number;
  finalMaxOutputTokens: number;
  incompleteReason?: string;
};

/** Cap for the §4.5 doubled truncation retry. */
export const OPENAI_MAX_OUTPUT_TOKENS_CAP = 32_000;

let lastDiagnostics: OpenAiJsonCallDiagnostics | null = null;
let truncationRetryTotal = 0;

export function getLastOpenAiJsonCallDiagnostics(): OpenAiJsonCallDiagnostics | null {
  return lastDiagnostics;
}

/** Cumulative truncation retries since last consume (for prepare diagnostics). */
export function consumeOpenAiTruncationRetryCount(): number {
  const n = truncationRetryTotal;
  truncationRetryTotal = 0;
  return n;
}

function extractText(res: OpenAiResponseShape): string | null {
  for (const block of res.output ?? []) {
    for (const c of block.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string" && c.text.trim()) {
        return c.text.trim();
      }
    }
  }
  // Legacy fallback shape
  const legacy = res.output?.flatMap((o) => o.content ?? []).find((c) => c.text)?.text;
  return legacy?.trim() ?? null;
}

function isReasoningModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4");
}

/**
 * Heuristic: response was cut off by the output token budget.
 * Exported for offline unit tests.
 */
export function looksLikeTruncatedOpenAiJson(input: {
  text: string;
  maxOutputTokens: number;
  response?: OpenAiResponseShape | null;
}): boolean {
  const res = input.response;
  if (res?.status === "incomplete") return true;
  if (res?.incomplete_details?.reason === "max_output_tokens") return true;
  const outTokens = res?.usage?.output_tokens;
  if (
    typeof outTokens === "number" &&
    Number.isFinite(outTokens) &&
    outTokens >= Math.floor(input.maxOutputTokens * 0.9)
  ) {
    return true;
  }
  const text = String(input.text ?? "");
  if (!text) return Boolean(res?.status === "incomplete");
  // ~2.5 chars/token for mixed RU/JSON; near-budget length suggests cut-off.
  const approxBudgetChars = input.maxOutputTokens * 2.5;
  if (text.length >= approxBudgetChars * 0.85) return true;
  const opens = (text.match(/[{[]/g) ?? []).length;
  const closes = (text.match(/[}\]]/g) ?? []).length;
  if (opens > closes) return true;
  if (/[,{:]\s*$/.test(text)) return true;
  return false;
}

function cleanJsonText(text: string): string {
  return text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

async function requestOpenAiJson(input: {
  systemPrompt: string;
  userPayload: unknown;
  maxOutputTokens: number;
  fetchImpl: FetchLike;
  apiKey: string;
  model: string;
  timeoutMs: number;
}): Promise<{ parsed: unknown; text: string; response: OpenAiResponseShape }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const res = await input.fetchImpl("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model,
        input: [
          { role: "system", content: [{ type: "input_text", text: input.systemPrompt }] },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(input.userPayload) }],
          },
        ],
        ...(isReasoningModel(input.model) ? { reasoning: { effort: "low" } } : {}),
        max_output_tokens: input.maxOutputTokens,
      }),
    });
    if (isOpenAiHttp429(res.status)) {
      throw new OpenAiCallError("openai-429", {
        retryable: true,
        status: 429,
        retryAfterMs: retryAfterMsFromResponse(res),
      });
    }
    if (!res.ok) {
      const retryable = res.status >= 500;
      throw new OpenAiCallError(`openai-http-${res.status}`, {
        retryable,
        status: res.status,
        retryAfterMs: retryable ? retryAfterMsFromResponse(res) : undefined,
      });
    }
    const json = (await res.json()) as OpenAiResponseShape;
    const text = extractText(json) ?? "";
    if (!text) {
      const truncatedEmpty = looksLikeTruncatedOpenAiJson({
        text: "",
        maxOutputTokens: input.maxOutputTokens,
        response: json,
      });
      throw new OpenAiCallError(
        truncatedEmpty ? "openai-truncated-empty" : "openai-empty-response",
        { retryable: false }
      );
    }
    const cleaned = cleanJsonText(text);
    try {
      return { parsed: JSON.parse(cleaned) as unknown, text: cleaned, response: json };
    } catch {
      const truncated = looksLikeTruncatedOpenAiJson({
        text: cleaned,
        maxOutputTokens: input.maxOutputTokens,
        response: json,
      });
      throw new OpenAiCallError(
        truncated ? "openai-truncated-json" : "openai-invalid-json",
        { retryable: false }
      );
    }
  } catch (err) {
    if (err instanceof OpenAiCallError) throw err;
    if (err instanceof OpenAiRateLimitError) {
      throw new OpenAiCallError(err.message, { retryable: true, status: 429 });
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (/abort/i.test(msg)) {
      throw new OpenAiCallError("openai-timeout", { retryable: true });
    }
    throw new OpenAiCallError(msg || "openai-json-failed", { retryable: true });
  } finally {
    clearTimeout(timeout);
  }
}

function isTruncationError(err: unknown): boolean {
  return (
    err instanceof OpenAiCallError &&
    (err.message === "openai-truncated-json" || err.message === "openai-truncated-empty")
  );
}

/** One-shot OpenAI JSON call — no queue retry loop; one §4.5 truncation bump. */
export async function callOpenAiStrictJsonOnce(input: {
  systemPrompt: string;
  userPayload: unknown;
  /** Override config budget (tests / stage-specific). */
  maxOutputTokens?: number;
  /** Injectable fetch for offline smokes. */
  fetchImpl?: FetchLike;
}): Promise<unknown> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const apiKey = digitalProfileConfig.aiAnalyst.openAiApiKey ?? "test-key";
  // Offline smokes inject fetchImpl and may not load a real AI config.
  if (!input.fetchImpl && (!digitalProfileConfig.aiAnalyst.openAiApiKey || !digitalProfileConfig.aiAnalyst.enabled)) {
    throw new OpenAiCallError("gpt55-required-but-unavailable", { retryable: false });
  }

  const model = digitalProfileConfig.aiAnalyst.model;
  const firstMax = Math.max(
    200,
    Math.min(
      OPENAI_MAX_OUTPUT_TOKENS_CAP,
      input.maxOutputTokens ?? digitalProfileConfig.aiAnalyst.maxOutputTokens
    )
  );
  lastDiagnostics = {
    truncationRetry: false,
    firstMaxOutputTokens: firstMax,
    finalMaxOutputTokens: firstMax,
  };

  const run = (maxOutputTokens: number) =>
    requestOpenAiJson({
      systemPrompt: input.systemPrompt,
      userPayload: input.userPayload,
      maxOutputTokens,
      fetchImpl,
      apiKey,
      model,
      timeoutMs: digitalProfileConfig.aiAnalyst.timeoutMs,
    });

  try {
    const first = await run(firstMax);
    if (
      looksLikeTruncatedOpenAiJson({
        text: first.text,
        maxOutputTokens: firstMax,
        response: first.response,
      }) &&
      // Valid JSON that still looks incomplete is rare; keep it unless API said incomplete.
      first.response.status === "incomplete"
    ) {
      // Parsed but marked incomplete — bump once for a fuller answer.
      const doubled = Math.min(OPENAI_MAX_OUTPUT_TOKENS_CAP, firstMax * 2);
      if (doubled > firstMax) {
        truncationRetryTotal += 1;
        lastDiagnostics = {
          truncationRetry: true,
          firstMaxOutputTokens: firstMax,
          finalMaxOutputTokens: doubled,
          incompleteReason: first.response.incomplete_details?.reason ?? "incomplete",
        };
        const second = await run(doubled);
        return second.parsed;
      }
    }
    return first.parsed;
  } catch (err) {
    if (!isTruncationError(err)) throw err;
    const doubled = Math.min(OPENAI_MAX_OUTPUT_TOKENS_CAP, firstMax * 2);
    if (doubled <= firstMax) throw err;
    truncationRetryTotal += 1;
    lastDiagnostics = {
      truncationRetry: true,
      firstMaxOutputTokens: firstMax,
      finalMaxOutputTokens: doubled,
      incompleteReason:
        err instanceof OpenAiCallError ? err.message : "openai-truncated-json",
    };
    const second = await run(doubled);
    return second.parsed;
  }
}

/**
 * OpenAI JSON call with queue-backed retries (default). Prefer this from
 * production callers; inject fakes in offline smokes instead.
 */
export async function callOpenAiStrictJson(input: {
  systemPrompt: string;
  userPayload: unknown;
  /** @deprecated Retries are owned by the queue; kept for call-site compat. */
  maxRetries?: number;
  maxOutputTokens?: number;
  fetchImpl?: FetchLike;
}): Promise<unknown> {
  const defaults = defaultGptCallQueueOptions();
  const maxAttempts = Math.max(1, input.maxRetries ?? defaults.maxAttempts);
  const queued = await runGptCallQueue({
    tasks: [
      {
        key: "openai-json",
        run: () =>
          callOpenAiStrictJsonOnce({
            systemPrompt: input.systemPrompt,
            userPayload: input.userPayload,
            maxOutputTokens: input.maxOutputTokens,
            fetchImpl: input.fetchImpl,
          }),
      },
    ],
    options: {
      concurrency: 1,
      maxAttempts,
      deadlineMs: defaults.deadlineMs,
      sleep: process.env.NETWORK_CALLS === "0" ? async () => undefined : undefined,
    },
  });
  const result = queued[0];
  if (!result || !result.ok) {
    const err = result && !result.ok ? result.error : new Error("openai-json-failed");
    throw err;
  }
  return result.value;
}
