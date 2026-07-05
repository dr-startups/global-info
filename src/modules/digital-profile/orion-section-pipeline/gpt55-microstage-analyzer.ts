import { digitalProfileConfig } from "../config";
import type { OrionEvidencePack, OrionGpt55SectionAnalysis, OrionMicroStage } from "./types";
import { buildDeterministicMicrostageAnalysis } from "./deterministic-microstage-analysis";
import { validateOrionMicrostageAnalysis } from "./gpt55-schemas";
import { logOrionPipeline, warnOrionPipeline } from "./orion-pipeline-logger";
import {
  buildNarrativeBlocksFromAnalysis,
  normalizeMetricCards,
  normalizeSlideTableRows,
} from "./client-slide-contract";

interface OpenAiResponseShape {
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

function buildSystemPrompt(): string {
  return [
    "You are a compliance-safe analyst for Digital Profile ORION reports.",
    "Analyze ONLY the provided evidence pack for one micro-stage.",
    "Do not browse, do not invent facts, do not use external knowledge.",
    "Do not make legal claims or legal conclusions.",
    "Distinguish official source records from legal conclusions.",
    "If official sanctions/watchlist/database records exist, say so explicitly without claiming guilt.",
    "Use Russian client-safe wording for RU reports.",
    "Never output ORION_STATIC, raw enum keys, provider/runtime/debug tokens, or placeholder labels like 'row'.",
    "Cite only evidenceRef IDs present in the evidence pack.",
    "Tables must use objects {label,value,note?,evidenceRef?} with non-empty label and value.",
    "Metric cards must be omitted when values are empty.",
    "Return strict JSON only, no markdown.",
  ].join(" ");
}

function slimEvidencePackForGpt(pack: OrionEvidencePack): OrionEvidencePack {
  const maxItems = digitalProfileConfig.aiAnalyst.maxInputItems;
  return {
    ...pack,
    topResults: pack.topResults.slice(0, maxItems).map((item) => ({
      ...item,
      snippet: typeof item.snippet === "string" ? item.snippet.slice(0, 400) : item.snippet,
      title: typeof item.title === "string" ? item.title.slice(0, 200) : item.title,
    })),
  };
}

function buildUserPrompt(input: { microStage: OrionMicroStage; evidencePack: OrionEvidencePack }): string {
  const evidencePack = slimEvidencePackForGpt(input.evidencePack);
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
          headline: "string (RU section title)",
          subheadline: "string (1-line client summary, not 'Этап анализа')",
          metricCards: [{ label: "string", value: "string|number" }],
          tables: [{ label: "string", value: "string", note: "string?", evidenceRef: "string?" }],
          narrativeBlocks: [{ title: "string", text: "string" }],
          screenshotRefs: ["evidenceRef from pack"],
          visualRefs: ["visualRef from pack"],
          evidenceRefs: ["evidenceRef from pack"],
        },
        warnings: ["string"],
      },
      microStage: {
        microStageKey: input.microStage.microStageKey,
        macroSectionKey: input.microStage.macroSectionKey,
        sectionNumber: input.microStage.sectionNumber,
        titleRu: input.microStage.titleRu,
      },
      evidencePack,
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

function retryDelayMs(error: unknown, attempt: number): number {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("429")) {
    return 4000 * attempt + Math.floor(Math.random() * 1000);
  }
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
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
      const body = await response.text().catch(() => "");
      const detail = body.replace(/\s+/g, " ").trim().slice(0, 240);
      throw new Error(
        `${TRANSIENT_HTTP_STATUSES.has(response.status) ? "openai-transient-http" : "openai-http"}-${response.status}${detail ? `:${detail}` : ""}`
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
  const maxAttempts = 5;
  let lastError: unknown;
  logOrionPipeline("gpt55", "openai-call-start", {
    microStageKey: input.microStage.microStageKey,
    model: input.model,
    evidenceItems: input.evidencePack.topResults.length,
  });
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await callOpenAiOnce(input);
      logOrionPipeline("gpt55", "openai-call-success", {
        microStageKey: input.microStage.microStageKey,
        attempt,
      });
      return result;
    } catch (error) {
      lastError = error;
      warnOrionPipeline("gpt55", "openai-call-retry", {
        microStageKey: input.microStage.microStageKey,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < maxAttempts && isTransientError(error)) {
        await sleep(retryDelayMs(error, attempt));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

function sanitizeGptAnalysis(analysis: import("./types").OrionGpt55SectionAnalysis) {
  const tables = normalizeSlideTableRows(analysis.slideContent.tables);
  const metricCards = normalizeMetricCards(analysis.slideContent.metricCards);
  const narrativeBlocks = buildNarrativeBlocksFromAnalysis(analysis).map((block) => ({
    title: block.title,
    text: block.text,
  }));
  const subheadline =
    analysis.slideContent.subheadline && analysis.slideContent.subheadline !== "Этап анализа"
      ? analysis.slideContent.subheadline
      : analysis.clientNarrative.plainConclusion.slice(0, 140);
  return {
    ...analysis,
    slideContent: {
      ...analysis.slideContent,
      subheadline,
      metricCards,
      tables,
      narrativeBlocks,
    },
  };
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
    warnOrionPipeline("gpt55", "fallback-ai-disabled", {
      microStageKey: input.microStage.microStageKey,
    });
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
    warnOrionPipeline("gpt55", "fallback-missing-api-key", {
      microStageKey: input.microStage.microStageKey,
    });
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
      warnOrionPipeline("gpt55", "fallback-schema-validation", {
        microStageKey: input.microStage.microStageKey,
        issues: valid.issues.slice(0, 3),
      });
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
      analysis: sanitizeGptAnalysis({ ...valid.value, generatedBy: "gpt-5.5" }),
      diagnostics: { provider: "openai", model: cfg.model, status: "ready" },
    };
  } catch (error) {
    warnOrionPipeline("gpt55", "fallback-openai-error", {
      microStageKey: input.microStage.microStageKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      analysis: buildDeterministicMicrostageAnalysis({
        microStage: input.microStage,
        evidencePack: input.evidencePack,
        reason: error instanceof Error ? error.message : "openai-call-failed",
      }),
      diagnostics: {
        provider: "openai",
        model: cfg.model,
        status: "fallback",
        reason: error instanceof Error ? error.message : "openai-call-failed",
      },
    };
  }
}

