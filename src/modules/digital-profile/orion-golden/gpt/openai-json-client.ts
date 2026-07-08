/**
 * R10 — OpenAI Responses API JSON helper (aligned with R9.7b GPT-5.5 client).
 */

import { digitalProfileConfig } from "../../config";
import { OpenAiRateLimitError, isOpenAiHttp429 } from "../../orion-report-spec/openai-rate-limit";

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

export async function callOpenAiStrictJson(input: {
  systemPrompt: string;
  userPayload: unknown;
  maxRetries?: number;
}): Promise<unknown> {
  const apiKey = digitalProfileConfig.aiAnalyst.openAiApiKey;
  if (!apiKey || !digitalProfileConfig.aiAnalyst.enabled) {
    throw new Error("gpt55-required-but-unavailable");
  }

  const model = digitalProfileConfig.aiAnalyst.model;
  const maxRetries = Math.max(1, input.maxRetries ?? 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), digitalProfileConfig.aiAnalyst.timeoutMs);
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
      if (isOpenAiHttp429(res.status)) throw new OpenAiRateLimitError("openai-429");
      if (!res.ok) throw new Error(`openai-http-${res.status}`);
      const json = (await res.json()) as OpenAiResponseShape;
      const text = extractText(json);
      if (!text) throw new Error("openai-empty-response");
      const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      return JSON.parse(cleaned) as unknown;
    } catch (err) {
      lastError = err;
      if (err instanceof OpenAiRateLimitError) throw err;
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("openai-json-failed");
}
