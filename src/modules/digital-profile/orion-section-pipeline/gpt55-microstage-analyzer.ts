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

async function callOpenAi(input: {
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
        max_output_tokens: digitalProfileConfig.aiAnalyst.maxOutputTokens,
      }),
    });
    if (!response.ok) {
      throw new Error(`openai-http-${response.status}`);
    }
    const json = (await response.json()) as OpenAiResponseShape;
    const text = extractText(json);
    if (!text) throw new Error("openai-empty-output");
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
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

