import type { AiAnalystEvidencePack } from "./evidence-pack";
import { aiAnalystNarrativeSchema } from "./schema";

interface OpenAiAnalystOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
}

function buildSystemPrompt(language: "ru" | "en"): string {
  if (language === "ru") {
    return [
      "Ты AI-аналитик для клиентского отчёта по цифровому профилю.",
      "Анализируй только предоставленные evidence данные.",
      "Запрещено: веб-браузинг, добавление новых фактов, юридические выводы, выдуманные подтверждения.",
      "Не используй слово 'подтверждено' без явного статуса confirmed в evidence.",
      "Чётко разделяй confirmed / potential / requires_review / excluded_noise.",
      "Объясни простым языком, почему риск MEDIUM возможен при 0 confirmedNegative.",
      "Сгруппируй темы в человекочитаемые формулировки.",
      "Сохраняй трассируемость к evidence (через количества и безопасные идентификаторы).",
      "Верни ТОЛЬКО JSON, строго по требуемой схеме.",
    ].join(" ");
  }
  return [
    "You are an AI analyst for a client-facing digital profile report.",
    "Analyze only provided evidence.",
    "No browsing, no new evidence collection, no legal conclusions, no invented facts.",
    "Do not mark anything as confirmed unless evidence status is confirmed.",
    "Separate confirmed / potential / requires_review / excluded_noise.",
    "Explain in plain language why MEDIUM risk can exist with zero confirmed negatives.",
    "Group technical themes into human-readable labels.",
    "Preserve evidence traceability through safe counts and IDs.",
    "Return JSON only, matching the required schema.",
  ].join(" ");
}

function buildUserPrompt(pack: AiAnalystEvidencePack): string {
  const schemaHint = {
    status: "ready",
    generatedBy: "gpt-5.5",
    provider: "openai",
    language: pack.language,
  };
  return JSON.stringify(
    {
      task: "Build client-readable analytical narrative from deterministic evidence pack.",
      strict_output: "json_only",
      schema_top_level_hint: schemaHint,
      evidencePack: pack,
    },
    null,
    2
  );
}

async function postChatCompletion(
  options: OpenAiAnalystOptions,
  pack: AiAnalystEvidencePack
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model || "gpt-5.5",
        temperature: 0.1,
        max_completion_tokens: options.maxOutputTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: buildSystemPrompt(pack.language) },
          { role: "user", content: buildUserPrompt(pack) },
        ],
      }),
    });
    if (!res.ok) {
      throw new Error(`openai_http_${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent || typeof rawContent !== "string") {
      throw new Error("openai_empty_content");
    }
    return JSON.parse(rawContent);
  } finally {
    clearTimeout(timer);
  }
}

export async function generateOpenAiGpt55Narrative(
  options: OpenAiAnalystOptions,
  pack: AiAnalystEvidencePack
) {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const raw = await postChatCompletion(options, pack);
      const parsed = aiAnalystNarrativeSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(
          `openai_schema_invalid:${parsed.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).join("|")}`
        );
      }
      return parsed.data;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("openai_unknown_error");
      const message = lastError.message.toLowerCase();
      const transient =
        message.includes("timeout") ||
        message.includes("abort") ||
        message.includes("http_429") ||
        message.includes("http_500") ||
        message.includes("http_502") ||
        message.includes("http_503");
      if (!transient || attempt > 0) {
        break;
      }
    }
  }
  throw lastError ?? new Error("openai_unknown_error");
}
