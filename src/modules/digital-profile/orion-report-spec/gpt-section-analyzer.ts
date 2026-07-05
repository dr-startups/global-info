import { z } from "zod";
import { digitalProfileConfig } from "../config";
import type { ReportAssetV1 } from "./asset-builder";
import { composeTargetSectionSlides } from "./slide-composer";
import { scanReportSpecClientText } from "./client-policy-scan";
import { buildDeterministicSectionAnalysis } from "./deterministic-section-analyzer";
import type { NormalizedEvidenceV1 } from "./normalized-evidence";
import type { OrionReportSectionKey, SectionAnalysisResult } from "./report-spec-schema";
import { SECTION_TITLES } from "./report-spec-schema";

interface OpenAiResponseShape {
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}

const sectionAnalysisSchema = z.object({
  sectionKey: z.enum(["executive_summary", "ru_audit_summary", "ru_search_results"]),
  title: z.string().min(1),
  subtitle: z.string().optional(),
  clientNarrative: z.object({
    headline: z.string().min(1),
    summary: z.string().min(1),
    whatWasFound: z.array(z.string()),
    whatWasNotConfirmed: z.array(z.string()),
    whyItMatters: z.string().min(1),
    riskInterpretation: z.string().min(1),
    manualReviewQueue: z.array(z.string()),
    recommendedNextSteps: z.array(z.string()),
  }),
  metrics: z.array(
    z.object({
      label: z.string().min(1),
      value: z.union([z.string(), z.number()]),
      tone: z.enum(["neutral", "low", "medium", "high", "warning"]).optional(),
    })
  ),
  evidenceHighlights: z.array(
    z.object({
      label: z.string().min(1),
      summary: z.string().min(1),
      evidenceRef: z.string().min(1),
      status: z.string().min(1),
    })
  ),
  slides: z.array(
    z.object({
      slideKey: z.string().min(1),
      template: z.enum([
        "orion_executive_summary",
        "orion_section_summary",
        "orion_serp_screenshot",
        "orion_evidence_explanation",
      ]),
      title: z.string().min(1),
      subtitle: z.string().optional(),
      narrative: z.string().optional(),
      bullets: z.array(z.string()).optional(),
      metricRefs: z.array(z.string()).optional(),
      evidenceRefs: z.array(z.string()).optional(),
      assetRefs: z.array(z.string()).optional(),
    })
  ),
});

function buildSystemPrompt(): string {
  return [
    "You are a compliance-safe analyst for Digital Profile ORION ReportSpec v1.",
    "Analyze ONLY the provided normalized evidence and asset summaries for ONE section.",
    "Do not browse, do not invent facts, do not use external knowledge.",
    "Do not make legal claims or legal conclusions.",
    "Distinguish public/search records, official database signals, and manual-review items.",
    "Write in natural client-facing Russian.",
    "Use only evidenceRef IDs from the input.",
    "Never output raw enum keys, internal terms, ORION_STATIC, COMMERCIAL_CONTEXT, mock, fallback, provider, runtime, debug, manifest, micro-stage.",
    "Status labels in evidenceHighlights must be Russian client-safe phrases, not English enum keys.",
    "Do not use generic tables with Поле/Значение or Этап анализа.",
    "Return strict JSON only, no markdown.",
  ].join(" ");
}

function slimEvidenceForGpt(evidence: NormalizedEvidenceV1[]): NormalizedEvidenceV1[] {
  const max = digitalProfileConfig.aiAnalyst.maxInputItems;
  return evidence.slice(0, max).map((e) => ({
    ...e,
    snippet: e.snippet?.slice(0, 400),
    clientSafeSummary: e.clientSafeSummary?.slice(0, 300),
  }));
}

function slimAssetsForGpt(assets: ReportAssetV1[]): Array<Record<string, unknown>> {
  return assets.map((a) => ({
    assetRef: a.assetRef,
    kind: a.kind,
    title: a.title,
    caption: a.caption,
    status: a.status,
    evidenceRefs: a.evidenceRefs,
    hasImage: Boolean(a.imageData || a.imageUrl),
  }));
}

function buildUserPrompt(input: {
  sectionKey: OrionReportSectionKey;
  subject: { displayName: string; locale: "ru" | "en" };
  evidence: NormalizedEvidenceV1[];
  assets: ReportAssetV1[];
}): string {
  return JSON.stringify(
    {
      task: "Analyze one ORION ReportSpec section and return strict JSON matching sectionAnalysisSchema.",
      sectionKey: input.sectionKey,
      sectionTitle: SECTION_TITLES[input.sectionKey],
      subject: input.subject,
      evidence: slimEvidenceForGpt(input.evidence),
      assets: slimAssetsForGpt(input.assets),
      requiredShape: {
        sectionKey: input.sectionKey,
        title: "string",
        clientNarrative: {
          headline: "string",
          summary: "string",
          whatWasFound: ["string"],
          whatWasNotConfirmed: ["string"],
          whyItMatters: "string",
          riskInterpretation: "string",
          manualReviewQueue: ["string"],
          recommendedNextSteps: ["string"],
        },
        metrics: [{ label: "string", value: "string|number", tone: "neutral|low|medium|high|warning" }],
        evidenceHighlights: [{ label: "string", summary: "string", evidenceRef: "string", status: "string (RU)" }],
        slides: [
          {
            slideKey: "string",
            template: "orion_executive_summary|orion_section_summary|orion_serp_screenshot|orion_evidence_explanation",
            title: "string",
            evidenceRefs: ["existing evidenceRef"],
            assetRefs: ["existing assetRef when relevant"],
          },
        ],
      },
    },
    null,
    2
  );
}

function extractText(res: OpenAiResponseShape): string | null {
  for (const block of res.output ?? []) {
    for (const c of block.content ?? []) {
      if (c.type === "output_text" && typeof c.text === "string" && c.text.trim()) {
        return c.text.trim();
      }
    }
  }
  return null;
}

function isReasoningModel(model: string): boolean {
  const m = model.trim().toLowerCase();
  return m.startsWith("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4");
}

function sanitizeGptSection(parsed: z.infer<typeof sectionAnalysisSchema>): z.infer<typeof sectionAnalysisSchema> {
  const scrub = (text: string) =>
    text
      .replace(/\bORION_STATIC\b/g, "")
      .replace(/\bCOMMERCIAL_CONTEXT\b/g, "")
      .replace(/\bcompliance_db_correction\b/gi, "")
      .replace(/\bmicro-stage\b/gi, "")
      .replace(/\brequires_review\b/gi, "Требует ручной проверки")
      .replace(/\bofficial_record_found\b/gi, "Подтверждённый сигнал")
      .replace(/\bnot_available\b/gi, "Данные недоступны")
      .replace(/\bexcluded_noise\b/gi, "Исключено как шум")
      .replace(/\bconfirmed_low_risk\b/gi, "Низкий риск")
      .trim();

  const walkStrings = (arr: string[]) => arr.map(scrub).filter(Boolean);
  return {
    ...parsed,
    title: scrub(parsed.title),
    subtitle: parsed.subtitle ? scrub(parsed.subtitle) : undefined,
    clientNarrative: {
      headline: scrub(parsed.clientNarrative.headline),
      summary: scrub(parsed.clientNarrative.summary),
      whatWasFound: walkStrings(parsed.clientNarrative.whatWasFound),
      whatWasNotConfirmed: walkStrings(parsed.clientNarrative.whatWasNotConfirmed),
      whyItMatters: scrub(parsed.clientNarrative.whyItMatters),
      riskInterpretation: scrub(parsed.clientNarrative.riskInterpretation),
      manualReviewQueue: walkStrings(parsed.clientNarrative.manualReviewQueue),
      recommendedNextSteps: walkStrings(parsed.clientNarrative.recommendedNextSteps),
    },
    evidenceHighlights: parsed.evidenceHighlights.map((h) => ({
      ...h,
      label: scrub(h.label),
      summary: scrub(h.summary),
      status: scrub(h.status),
    })),
    slides: parsed.slides.map((s) => ({
      ...s,
      title: scrub(s.title),
      subtitle: s.subtitle ? scrub(s.subtitle) : undefined,
      narrative: s.narrative ? scrub(s.narrative) : undefined,
      bullets: s.bullets ? walkStrings(s.bullets) : undefined,
    })),
  };
}

async function callOpenAiOnce(input: {
  sectionKey: OrionReportSectionKey;
  subject: { displayName: string; locale: "ru" | "en" };
  evidence: NormalizedEvidenceV1[];
  assets: ReportAssetV1[];
}): Promise<unknown> {
  const apiKey = digitalProfileConfig.aiAnalyst.openAiApiKey;
  if (!apiKey) throw new Error("openai-key-not-configured");
  const model = digitalProfileConfig.aiAnalyst.model;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), digitalProfileConfig.aiAnalyst.timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        input: [
          { role: "system", content: [{ type: "input_text", text: buildSystemPrompt() }] },
          { role: "user", content: [{ type: "input_text", text: buildUserPrompt(input) }] },
        ],
        ...(isReasoningModel(model) ? { reasoning: { effort: "low" } } : {}),
        max_output_tokens: digitalProfileConfig.aiAnalyst.maxOutputTokens,
      }),
    });
    if (!response.ok) {
      throw new Error(`openai-http-${response.status}`);
    }
    const json = (await response.json()) as OpenAiResponseShape;
    const text = extractText(json);
    if (!text) throw new Error("openai-empty-response");
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeOrionSectionWithGpt55(input: {
  sectionKey: OrionReportSectionKey;
  subject: { displayName: string; locale: "ru" | "en" };
  evidence: NormalizedEvidenceV1[];
  assets: ReportAssetV1[];
  language: "ru";
  requireAi: boolean;
  allowDeterministicFallback?: boolean;
}): Promise<SectionAnalysisResult> {
  const evidenceRefs = new Set(input.evidence.map((e) => e.evidenceRef));
  const assetRefs = new Set(input.assets.map((a) => a.assetRef));
  const warnings: string[] = [];

  const aiReady =
    digitalProfileConfig.aiAnalyst.enabled &&
    Boolean(digitalProfileConfig.aiAnalyst.openAiApiKey) &&
    digitalProfileConfig.aiAnalyst.provider === "openai";

  if (!aiReady) {
    if (input.requireAi && !input.allowDeterministicFallback) {
      throw new Error("gpt55-required-but-unavailable");
    }
    const fallback = buildDeterministicSectionAnalysis({
      sectionKey: input.sectionKey,
      subjectName: input.subject.displayName,
      evidence: input.evidence,
      assets: input.assets,
    });
    warnings.push("deterministic-fallback:no-ai");
    return { ...fallback, warnings };
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const raw = await callOpenAiOnce(input);
      const parsed = sanitizeGptSection(sectionAnalysisSchema.parse(raw));
      for (const h of parsed.evidenceHighlights) {
        if (!evidenceRefs.has(h.evidenceRef)) {
          throw new Error(`invalid-evidence-ref:${h.evidenceRef}`);
        }
      }
      for (const slide of parsed.slides) {
        for (const ref of slide.evidenceRefs ?? []) {
          if (!evidenceRefs.has(ref)) throw new Error(`invalid-slide-evidence-ref:${ref}`);
        }
        for (const ref of slide.assetRefs ?? []) {
          if (!assetRefs.has(ref)) throw new Error(`invalid-slide-asset-ref:${ref}`);
        }
      }
      const issues = scanReportSpecClientText(JSON.stringify(parsed));
      if (issues.length > 0) {
        throw new Error(`client-policy-violation:${issues.join(",")}`);
      }
      return {
        sectionKey: input.sectionKey,
        generatedBy: "gpt-5.5",
        section: {
          ...parsed,
          slides: composeTargetSectionSlides({
            sectionKey: input.sectionKey,
            section: parsed,
            evidence: input.evidence,
            assets: input.assets,
          }),
        },
        warnings,
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  if (input.requireAi && !input.allowDeterministicFallback) {
    throw lastError instanceof Error ? lastError : new Error("gpt55-failed");
  }
  const fallback = buildDeterministicSectionAnalysis({
    sectionKey: input.sectionKey,
    subjectName: input.subject.displayName,
    evidence: input.evidence,
    assets: input.assets,
  });
  warnings.push(`deterministic-fallback:${lastError instanceof Error ? lastError.message : "gpt-failed"}`);
  return { ...fallback, warnings };
}
