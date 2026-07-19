/**
 * R10 — OpenAI Responses API JSON helper (aligned with R9.7b GPT-5.5 client).
 *
 * REMEDIATION §4.2: this client performs a single HTTP attempt and classifies
 * failures. Retries / rate-limit backoff live in `gpt-call-queue.ts`.
 */

import { digitalProfileConfig } from "../../config";
import { OpenAiRateLimitError, isOpenAiHttp429 } from "../../orion-report-spec/openai-rate-limit";
import {
  OpenAiCallError,
  retryAfterMsFromResponse,
  runGptCallQueue,
  defaultGptCallQueueOptions,
} from "./gpt-call-queue";

interface OpenAiResponseShape {
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
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

/** One-shot OpenAI JSON call — no internal retry loop. */
export async function callOpenAiStrictJsonOnce(input: {
  systemPrompt: string;
  userPayload: unknown;
}): Promise<unknown> {
  const apiKey = digitalProfileConfig.aiAnalyst.openAiApiKey;
  if (!apiKey || !digitalProfileConfig.aiAnalyst.enabled) {
    throw new OpenAiCallError("gpt55-required-but-unavailable", { retryable: false });
  }

  const model = digitalProfileConfig.aiAnalyst.model;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    digitalProfileConfig.aiAnalyst.timeoutMs
  );
  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: input.systemPrompt }] },
          {
            role: "user",
            content: [{ type: "input_text", text: JSON.stringify(input.userPayload) }],
          },
        ],
        ...(isReasoningModel(model) ? { reasoning: { effort: "low" } } : {}),
        max_output_tokens: digitalProfileConfig.aiAnalyst.maxOutputTokens,
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
    const text = extractText(json);
    if (!text) throw new OpenAiCallError("openai-empty-response", { retryable: false });
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    try {
      return JSON.parse(cleaned) as unknown;
    } catch {
      throw new OpenAiCallError("openai-invalid-json", { retryable: false });
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

/**
 * OpenAI JSON call with queue-backed retries (default). Prefer this from
 * production callers; inject fakes in offline smokes instead.
 */
export async function callOpenAiStrictJson(input: {
  systemPrompt: string;
  userPayload: unknown;
  /** @deprecated Retries are owned by the queue; kept for call-site compat. */
  maxRetries?: number;
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
