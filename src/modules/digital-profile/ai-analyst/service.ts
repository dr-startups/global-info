import { digitalProfileConfig } from "../config";
import type { AiAnalystNarrative, ReportJson } from "../types";
import { buildDeterministicAiAnalystNarrative } from "./deterministic-narrative";
import { buildAiAnalystEvidencePack } from "./evidence-pack";
import { generateOpenAiGpt55Narrative } from "./openai-gpt55-analyst";
import { validateAiAnalystNarrative } from "./schema";

export interface AiAnalystGenerationOutcome {
  narrative: AiAnalystNarrative;
  diagnostics: {
    enabled: boolean;
    provider: "openai" | "none";
    model: string;
    status: "ready" | "fallback" | "unavailable";
    reason?: string;
  };
}

function fallbackReasonLabel(reason: string | undefined, lang: "ru" | "en"): string {
  if (!reason) return "";
  const low = reason.toLowerCase();
  if (low.includes("api_key")) return lang === "ru" ? "API key missing" : "API key missing";
  if (low.includes("timeout") || low.includes("abort"))
    return lang === "ru" ? "timeout" : "timeout";
  if (low.includes("schema") || low.includes("json"))
    return lang === "ru" ? "invalid model response" : "invalid model response";
  if (low.includes("http_401") || low.includes("http_403"))
    return lang === "ru" ? "API key missing" : "API key missing";
  return lang === "ru" ? "provider unavailable" : "provider unavailable";
}

export async function generateAiAnalystNarrative(
  reportJson: ReportJson
): Promise<AiAnalystGenerationOutcome> {
  const lang = reportJson.reportLanguage === "en" ? "en" : "ru";
  const cfg = digitalProfileConfig.aiAnalyst;
  const pack = buildAiAnalystEvidencePack(reportJson, {
    maxInputItems: cfg.maxInputItems,
  });

  const fallbackBase = buildDeterministicAiAnalystNarrative(pack, { status: "fallback" });
  if (!cfg.enabled) {
    return {
      narrative: {
        ...fallbackBase,
        status: "fallback",
        generatedBy: "deterministic",
        provider: "none",
      },
      diagnostics: {
        enabled: false,
        provider: "none",
        model: cfg.model,
        status: "fallback",
        reason: lang === "ru" ? "disabled by config" : "disabled by config",
      },
    };
  }

  const apiKey = cfg.openAiApiKey;
  if (!apiKey) {
    const reason = "api_key_missing";
    return {
      narrative: buildDeterministicAiAnalystNarrative(pack, {
        status: "fallback",
        warnings: [fallbackReasonLabel(reason, lang)],
      }),
      diagnostics: {
        enabled: true,
        provider: "openai",
        model: cfg.model,
        status: "fallback",
        reason: fallbackReasonLabel(reason, lang),
      },
    };
  }

  try {
    const generated = await generateOpenAiGpt55Narrative(
      {
        apiKey,
        model: cfg.model,
        timeoutMs: cfg.timeoutMs,
        maxOutputTokens: cfg.maxOutputTokens,
      },
      pack
    );
    const validated = validateAiAnalystNarrative(generated);
    if (!validated.ok) {
      throw new Error(`schema_invalid:${validated.issues.join("|")}`);
    }
    const narrative: AiAnalystNarrative = {
      ...validated.value,
      status: "ready",
      generatedBy: "gpt-5.5",
      provider: "openai",
      language: lang,
      generatedAt: validated.value.generatedAt ?? new Date().toISOString(),
      meta: {
        ...validated.value.meta,
        evidenceItemsUsed: pack.meta.evidenceItemsUsed,
        truncatedInput: pack.meta.truncatedInput,
        warnings: [
          ...(validated.value.meta.warnings ?? []),
          ...pack.meta.warnings,
        ].slice(0, 20),
      },
    };
    return {
      narrative,
      diagnostics: {
        enabled: true,
        provider: "openai",
        model: cfg.model,
        status: "ready",
      },
    };
  } catch (error) {
    const reason = fallbackReasonLabel(error instanceof Error ? error.message : "unknown", lang);
    return {
      narrative: buildDeterministicAiAnalystNarrative(pack, {
        status: "fallback",
        warnings: reason ? [reason] : [],
      }),
      diagnostics: {
        enabled: true,
        provider: "openai",
        model: cfg.model,
        status: "fallback",
        reason,
      },
    };
  }
}
