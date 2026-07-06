import { digitalProfileConfig } from "../config";
import type { ReportAssetV1 } from "../orion-report-spec/asset-builder";
import { OpenAiRateLimitError, isOpenAiHttp429 } from "../orion-report-spec/openai-rate-limit";
import type { NormalizedEvidenceV1 } from "../orion-report-spec/normalized-evidence";
import type { OrionReportSectionKey, SectionAnalysisResult } from "../orion-report-spec/report-spec-schema";
import { SECTION_TITLES } from "../orion-report-spec/report-spec-schema";
import { gptStoryboardSectionAnalysisSchema, validateGptStoryboardSectionAnalysis } from "./schema";
import type { ClientSlideType, GptStoryboardSectionAnalysis } from "./types";

function buildStoryboardSystemPrompt(): string {
  return [
    "You are a compliance-safe ORION client storyboard analyst.",
    "Return strict JSON for ONE section with slidePlans for designed client slides.",
    "Write in natural Russian for client-visible fields.",
    "Never use raw enum keys (adverse_media, pep, PRESENT, UNKNOWN).",
    "No legal conclusions. No mock/fallback/provider/runtime/debug wording.",
    "Max 3 slidePlans per section. Max 5 bullets per slide.",
    "Each sensitive claim must reference evidenceRef from input.",
    "If evidence is weak, say 'требует ручной проверки'.",
    "Do not repeat generic phrases.",
  ].join(" ");
}

function buildStoryboardUserPrompt(input: {
  sectionKey: OrionReportSectionKey;
  subject: { displayName: string };
  evidence: NormalizedEvidenceV1[];
  assets: ReportAssetV1[];
}): string {
  return JSON.stringify({
    sectionKey: input.sectionKey,
    sectionTitle: SECTION_TITLES[input.sectionKey],
    subject: input.subject,
    evidence: input.evidence.slice(0, 24).map((e) => ({
      evidenceRef: e.evidenceRef,
      title: e.title,
      snippet: e.snippet?.slice(0, 280),
      riskTheme: e.riskTheme,
      reviewStatus: e.reviewStatus,
    })),
    assets: input.assets.map((a) => ({ assetRef: a.assetRef, kind: a.kind, status: a.status, title: a.title })),
    requiredShape: {
      sectionKey: input.sectionKey,
      executiveTakeaway: "string",
      clientExplanation: "string",
      riskInterpretation: "string",
      confirmedFacts: ["string"],
      unconfirmedSignals: ["string"],
      manualReviewQueue: ["string"],
      recommendedActions: ["string"],
      slidePlans: [
        {
          slideKey: "string",
          slideType: "executive_summary|region_summary|search_overview|serp_screenshot|...",
          title: "string",
          clientTakeaway: "string",
          bullets: ["string"],
          evidenceRefs: ["string"],
          assetRefs: ["string"],
        },
      ],
    },
  });
}

function extractText(json: { output?: Array<{ content?: Array<{ text?: string }> }> }): string {
  const parts: string[] = [];
  for (const item of json.output ?? []) {
    for (const c of item.content ?? []) {
      if (c.text) parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

function isReasoningModel(model: string): boolean {
  return /^(o\d|gpt-5)/i.test(model);
}

export function mapSectionAnalysisToStoryboard(
  analysis: SectionAnalysisResult,
  sectionKey: OrionReportSectionKey
): GptStoryboardSectionAnalysis {
  const n = analysis.section.clientNarrative;
  const slideType: ClientSlideType =
    sectionKey === "executive_summary"
      ? "executive_summary"
      : sectionKey === "ru_audit_summary"
        ? "region_summary"
        : "search_overview";
  return {
    sectionKey,
    generatedBy: analysis.generatedBy,
    executiveTakeaway: n.headline,
    clientExplanation: n.summary,
    riskInterpretation: n.riskInterpretation,
    confirmedFacts: n.whatWasFound.slice(0, 5),
    unconfirmedSignals: n.whatWasNotConfirmed.slice(0, 5),
    manualReviewQueue: n.manualReviewQueue.slice(0, 5),
    recommendedActions: n.recommendedNextSteps.slice(0, 5),
    slidePlans: [
      {
        slideKey: `${sectionKey}-main`,
        slideType,
        title: analysis.section.title,
        subtitle: analysis.section.subtitle,
        clientTakeaway: n.summary.slice(0, 220),
        bullets: [...n.whatWasFound.slice(0, 3), ...n.manualReviewQueue.slice(0, 2)].slice(0, 5),
        evidenceRefs: analysis.section.evidenceHighlights.map((h) => h.evidenceRef).slice(0, 6),
      },
    ],
    warnings: analysis.warnings,
  };
}

export function buildDeterministicStoryboardAnalysis(input: {
  sectionKey: OrionReportSectionKey;
  subjectName: string;
  evidence: NormalizedEvidenceV1[];
}): GptStoryboardSectionAnalysis {
  const rows = input.evidence.slice(0, 6);
  return {
    sectionKey: input.sectionKey,
    generatedBy: "deterministic",
    executiveTakeaway: `Сводка по разделу ${SECTION_TITLES[input.sectionKey]} для ${input.subjectName}`,
    clientExplanation: "Анализ основан на нормализованных материалах из открытых источников.",
    riskInterpretation: "Существенных автоматически подтверждённых негативных выводов не сформировано.",
    confirmedFacts: rows.slice(0, 3).map((e) => e.clientSafeSummary ?? e.title ?? "Материал из открытых источников"),
    unconfirmedSignals: ["Отдельные публикации требуют ручной верификации связи с субъектом."],
    manualReviewQueue: rows
      .filter((e) => e.reviewStatus === "requires_review")
      .slice(0, 3)
      .map((e) => e.title ?? "Элемент очереди проверки"),
    recommendedActions: ["Провести ручную верификацию спорных сигналов.", "Зафиксировать решение в карточке кейса."],
    slidePlans: [
      {
        slideKey: `${input.sectionKey}-det`,
        slideType:
          input.sectionKey === "executive_summary"
            ? "executive_summary"
            : input.sectionKey === "ru_audit_summary"
              ? "region_summary"
              : "search_overview",
        title: SECTION_TITLES[input.sectionKey],
        clientTakeaway: "Краткая клиентская сводка по доступным данным.",
        bullets: rows.slice(0, 4).map((e) => e.clientSafeSummary ?? e.title ?? "Источник"),
        evidenceRefs: rows.map((e) => e.evidenceRef),
      },
    ],
    warnings: ["deterministic-storyboard"],
  };
}

export async function analyzeStoryboardSectionWithGpt55(input: {
  sectionKey: OrionReportSectionKey;
  subject: { displayName: string; locale: "ru" | "en" };
  evidence: NormalizedEvidenceV1[];
  assets: ReportAssetV1[];
  requireAi: boolean;
  allowDeterministicFallback?: boolean;
  maxOpenaiRetries?: number;
}): Promise<GptStoryboardSectionAnalysis> {
  const aiReady =
    digitalProfileConfig.aiAnalyst.enabled &&
    Boolean(digitalProfileConfig.aiAnalyst.openAiApiKey) &&
    digitalProfileConfig.aiAnalyst.provider === "openai";

  if (!aiReady) {
    if (input.requireAi && !input.allowDeterministicFallback) {
      throw new Error("gpt55-required-but-unavailable");
    }
    return buildDeterministicStoryboardAnalysis({
      sectionKey: input.sectionKey,
      subjectName: input.subject.displayName,
      evidence: input.evidence,
    });
  }

  const apiKey = digitalProfileConfig.aiAnalyst.openAiApiKey!;
  const model = digitalProfileConfig.aiAnalyst.model;
  const maxRetries = Math.max(1, input.maxOpenaiRetries ?? 3);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          input: [
            { role: "system", content: [{ type: "input_text", text: buildStoryboardSystemPrompt() }] },
            {
              role: "user",
              content: [{ type: "input_text", text: buildStoryboardUserPrompt(input) }],
            },
          ],
          ...(isReasoningModel(model) ? { reasoning: { effort: "low" } } : {}),
          max_output_tokens: digitalProfileConfig.aiAnalyst.maxOutputTokens,
        }),
      });
      if (!response.ok) throw new Error(`openai-http-${response.status}`);
      const json = (await response.json()) as { output?: Array<{ content?: Array<{ text?: string }> }> };
      const text = extractText(json);
      if (!text) throw new Error("openai-empty-response");
      const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = validateGptStoryboardSectionAnalysis(JSON.parse(cleaned));
      return { ...parsed, generatedBy: "gpt-5.5", warnings: [] };
    } catch (error) {
      lastError = error;
      if (isOpenAiHttp429(error) && attempt >= maxRetries) throw new OpenAiRateLimitError();
      if (attempt < maxRetries) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  if (input.requireAi && !input.allowDeterministicFallback) {
    if (isOpenAiHttp429(lastError)) throw new OpenAiRateLimitError();
    throw lastError instanceof Error ? lastError : new Error("gpt55-storyboard-failed");
  }
  return buildDeterministicStoryboardAnalysis({
    sectionKey: input.sectionKey,
    subjectName: input.subject.displayName,
    evidence: input.evidence,
  });
}
