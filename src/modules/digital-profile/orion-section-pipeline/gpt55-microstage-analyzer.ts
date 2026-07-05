import { digitalProfileConfig } from "../config";
import type { OrionEvidencePack, OrionGpt55SectionAnalysis, OrionMicroStage } from "./types";
import { buildDeterministicMicrostageAnalysis } from "./deterministic-microstage-analysis";
import { validateOrionMicrostageAnalysis } from "./gpt55-schemas";

interface OpenAiResponseShape {
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

function buildSystemPrompt(): string {
  return [
    "You are a compliance-safe analyst for Digital Profile reports.",
    "Analyze ONLY the provided evidence pack for one micro-stage.",
    "Do not browse, do not invent facts, do not use external knowledge.",
    "Do not make legal claims or legal conclusions.",
    "Ambiguous findings must stay requires_review.",
    "Return strict JSON only, no markdown.",
  ].join(" ");
}

function buildUserPrompt(input: { microStage: OrionMicroStage; evidencePack: OrionEvidencePack }): string {
  return JSON.stringify(
    {
      task: "Analyze one ORION micro-stage evidence pack and return strict JSON.",
      requiredShape: {
        microStageKey: "string",
        macroSectionKey: "string",
        sectionNumber: "string|null",
        titleRu: "string",
        status: "ready|fallback|unavailable",
        generatedBy: "gpt-5.5|deterministic",
        clientNarrative: {
          plainConclusion: "string",
          whatWasFound: ["string"],
          whatWasNotConfirmed: ["string"],
          whatRequiresReview: ["string"],
          whyItMatters: "string",
          recommendedActions: ["string"],
        },
        evidenceSummary: {
          total: 0,
          confirmed: 0,
          undesirable: 0,
          potential: 0,
          requiresReview: 0,
          excludedNoise: 0,
          keyDomains: ["string"],
          keyThemes: ["string"],
        },
        slideContent: {
          headline: "string",
          subheadline: "string",
          metricCards: [],
          tables: [],
          narrativeBlocks: [],
          screenshotRefs: ["string"],
          visualRefs: ["string"],
          evidenceRefs: ["string"],
        },
        warnings: ["string"],
      },
      microStage: {
        microStageKey: input.microStage.microStageKey,
        macroSectionKey: input.microStage.macroSectionKey,
        sectionNumber: input.microStage.sectionNumber,
        titleRu: input.microStage.titleRu,
      },
      evidencePack: input.evidencePack,
    },
    null,
    2
  );
}

function isReasoningModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4");
}

function extractText(res: OpenAiResponseShape): string | null {
  const blocks = Array.isArray(res.output) ? res.output : [];
  for (const block of blocks) {
    const content = Array.isArray(block.content) ? block.content : [];
    for (const c of content) {
      if (c.type === "output_text" && typeof c.text === "string" && c.text.trim().length > 0) {
        return c.text.trim();
      }
    }
  }
  return null;
}

const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function isTransientError(error: unknown): boolean {
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    const msg = error.message.toLowerCase();
    if (msg.includes("openai-transient-http")) return true;
    // Node fetch network failures surface as generic TypeError.
    if (error.name === "TypeError" || msg.includes("fetch failed") || msg.includes("network")) {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOpenAiOnce(input: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  microStage: OrionMicroStage;
  evidencePack: OrionEvidencePack;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: input.model,
        input: [
          { role: "system", content: [{ type: "input_text", text: buildSystemPrompt() }] },
          {
            role: "user",
            content: [{ type: "input_text", text: buildUserPrompt({ microStage: input.microStage, evidencePack: input.evidencePack }) }],
          },
        ],
        // GPT-5.x are reasoning models: reasoning tokens count against the output
        // budget. Keep effort low for structured extraction so the JSON body fits.
        ...(isReasoningModel(input.model) ? { reasoning: { effort: "low" } } : {}),
        max_output_tokens: digitalProfileConfig.aiAnalyst.maxOutputTokens,
      }),
    });
    if (!response.ok) {
      // Distinguish transient (retryable) from permanent HTTP failures.
      throw new Error(
        `${TRANSIENT_HTTP_STATUSES.has(response.status) ? "openai-transient-http" : "openai-http"}-${response.status}`
      );
    }
    const json = (await response.json()) as OpenAiResponseShape;
    const text = extractText(json);
    if (!text) throw new Error("openai-empty-output");
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAi(input: {
  apiKey: string;
  model: string;
  timeoutMs: number;
  microStage: OrionMicroStage;
  evidencePack: OrionEvidencePack;
}): Promise<unknown> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callOpenAiOnce(input);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && isTransientError(error)) {
        // Exponential backoff with jitter to ride out rate limits / hiccups.
        await sleep(500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export async function analyzeMicroStageWithGpt55(input: {
  microStage: OrionMicroStage;
  evidencePack: OrionEvidencePack;
}): Promise<{
  analysis: OrionGpt55SectionAnalysis;
  diagnostics: { provider: "openai" | "none"; model: string; status: "ready" | "fallback" | "unavailable"; reason?: string };
}> {
  const cfg = digitalProfileConfig.aiAnalyst;
  if (!cfg.enabled) {
    return {
      analysis: buildDeterministicMicrostageAnalysis({
        microStage: input.microStage,
        evidencePack: input.evidencePack,
        reason: "ai-analyst-disabled",
      }),
      diagnostics: { provider: "none", model: cfg.model, status: "fallback", reason: "ai-analyst-disabled" },
    };
  }

  if (!cfg.openAiApiKey) {
    return {
      analysis: buildDeterministicMicrostageAnalysis({
        microStage: input.microStage,
        evidencePack: input.evidencePack,
        reason: "openai-api-key-missing",
      }),
      diagnostics: { provider: "none", model: cfg.model, status: "fallback", reason: "openai-api-key-missing" },
    };
  }

  try {
    const raw = await callOpenAi({
      apiKey: cfg.openAiApiKey,
      model: cfg.model || "gpt-5.5",
      timeoutMs: cfg.timeoutMs,
      microStage: input.microStage,
      evidencePack: input.evidencePack,
    });
    const valid = validateOrionMicrostageAnalysis(raw);
    if (!valid.ok) {
      return {
        analysis: buildDeterministicMicrostageAnalysis({
          microStage: input.microStage,
          evidencePack: input.evidencePack,
          reason: `schema-validation-failed: ${valid.issues.slice(0, 3).join("; ")}`,
        }),
        diagnostics: { provider: "openai", model: cfg.model, status: "fallback", reason: "schema-validation-failed" },
      };
    }
    return {
      analysis: valid.value,
      diagnostics: { provider: "openai", model: cfg.model, status: "ready" },
    };
  } catch (error) {
    return {
      analysis: buildDeterministicMicrostageAnalysis({
        microStage: input.microStage,
        evidencePack: input.evidencePack,
        reason: error instanceof Error ? error.message : "openai-call-failed",
      }),
      diagnostics: { provider: "openai", model: cfg.model, status: "fallback", reason: "openai-call-failed" },
    };
  }
}

