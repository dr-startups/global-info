import { digitalProfileConfig } from "../config";
import type { ReportAssetV1 } from "../orion-report-spec/asset-builder";
import { OpenAiRateLimitError, isOpenAiHttp429 } from "../orion-report-spec/openai-rate-limit";
import type { NormalizedEvidenceV1 } from "../orion-report-spec/normalized-evidence";
import type { OrionReportSectionKey, SectionAnalysisResult } from "../orion-report-spec/report-spec-schema";
import { SECTION_TITLES } from "../orion-report-spec/report-spec-schema";
import {
  assertNoClientHostileTokens,
  sanitizeClientNarrativeText,
  sanitizeStringArray,
} from "./client-text-contract";
import { gptStoryboardSectionAnalysisSchema, validateGptStoryboardSectionAnalysis } from "./schema";
import type { ClassifiedEvidence } from "./evidence-relevance-classifier";
import type { ClientSlideType, GptStoryboardSectionAnalysis, GptStoryboardSectionKey } from "./types";

const STORYBOARD_SECTION_TITLES: Record<GptStoryboardSectionKey, string> = {
  executive_summary: SECTION_TITLES.executive_summary,
  ru_audit_summary: SECTION_TITLES.ru_audit_summary,
  ru_search_results: SECTION_TITLES.ru_search_results,
  lexis_summary: "LexisNexis — аналитическая сводка",
  recommended_actions: "Рекомендуемые действия",
};

function buildStoryboardSystemPrompt(): string {
  return [
    "You are a compliance-safe ORION client storyboard analyst.",
    "Return strict JSON for ONE section.",
    "Write in natural Russian for all client-visible fields.",
    "NEVER output raw evidenceRef, assetRef, cmr IDs, storage paths, enum keys, or internal refs.",
    "Never use adverse_media, pep, PRESENT, UNKNOWN as raw labels.",
    "No legal conclusions. No mock/fallback/provider/runtime/debug wording.",
    "Max 3 slidePlans. Max 5 bullets per slide.",
    "Explain false positives and excluded noise when relevant.",
    "Vary phrasing — do not repeat 'требует ручной проверки' in every bullet.",
    "If data quality is weak, say so plainly.",
    "Frame sanctions/watchlist as potential compliance match requiring verification.",
  ].join(" ");
}

function buildStoryboardUserPrompt(input: {
  sectionKey: GptStoryboardSectionKey;
  subject: { displayName: string };
  evidence: NormalizedEvidenceV1[];
  classifiedEvidence?: ClassifiedEvidence[];
  assets: ReportAssetV1[];
  lexisMeta?: { parsedSignals: number; visualPages: number; uploadExists: boolean };
}): string {
  const classified = input.classifiedEvidence?.slice(0, 20) ?? [];
  return JSON.stringify({
    sectionKey: input.sectionKey,
    sectionTitle: STORYBOARD_SECTION_TITLES[input.sectionKey],
    subject: input.subject,
    evidenceForAnalysis: classified.map((c, i) => ({
      index: i + 1,
      title: c.evidence.title,
      snippet: c.evidence.snippet?.slice(0, 280),
      domain: c.evidence.domain,
      relevance: c.type,
      humanReason: c.humanReason,
    })),
    assets: input.assets.map((a) => ({ kind: a.kind, status: a.status, title: a.title })),
    lexisMeta: input.lexisMeta,
    requiredShape: {
      sectionKey: input.sectionKey,
      clientTitle: "string",
      executiveTakeaway: "string",
      clientExplanation: "string",
      riskInterpretation: "string OR { level, plainLanguageReason, notConfirmedDisclaimer }",
      whatWasChecked: ["string"],
      whatWasFound: ["string"],
      whatItMeans: ["string"],
      whatRequiresManualReview: ["string"],
      excludedNoiseSummary: ["string"],
      confidence: "high|medium|low",
      confirmedFacts: ["string — human readable, no IDs"],
      unconfirmedSignals: ["string"],
      manualReviewQueue: ["string"],
      recommendedActions: ["string"],
      evidenceExamples: [
        {
          humanTitle: "string",
          source: "string",
          domain: "string",
          whyIncluded: "string",
          clientSafeStatus: "relevant|requires_review|excluded_from_risk",
        },
      ],
      clientWarnings: ["string"],
      slidePlans: [
        {
          slideKey: "string",
          slideType: "executive_summary|scope_overview|risk_conclusion|region_summary|relevant_sources|excluded_matches|lexisnexis_summary|lexisnexis_signals|recommended_actions",
          title: "string",
          clientTakeaway: "string",
          bullets: ["string — no IDs"],
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

function normalizeRiskInterpretation(raw: unknown): { text: string; structured?: GptStoryboardSectionAnalysis["structuredRisk"] } {
  if (typeof raw === "string") return { text: sanitizeClientNarrativeText(raw) };
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, string>;
    const structured = {
      level: (o.level ?? "review_required") as "low" | "medium" | "high" | "review_required",
      plainLanguageReason: sanitizeClientNarrativeText(o.plainLanguageReason ?? ""),
      notConfirmedDisclaimer: sanitizeClientNarrativeText(o.notConfirmedDisclaimer ?? ""),
    };
    return {
      text: [structured.plainLanguageReason, structured.notConfirmedDisclaimer].filter(Boolean).join(" "),
      structured,
    };
  }
  return { text: "" };
}

export function sanitizeGptStoryboardAnalysis(
  raw: GptStoryboardSectionAnalysis,
  seed = 0
): GptStoryboardSectionAnalysis {
  const risk = normalizeRiskInterpretation(raw.riskInterpretation);
  const sanitized: GptStoryboardSectionAnalysis = {
    ...raw,
    clientTitle: raw.clientTitle ? sanitizeClientNarrativeText(raw.clientTitle) : undefined,
    executiveTakeaway: sanitizeClientNarrativeText(raw.executiveTakeaway),
    clientExplanation: sanitizeClientNarrativeText(raw.clientExplanation),
    riskInterpretation: risk.text,
    structuredRisk: raw.structuredRisk ?? risk.structured,
    whatWasChecked: sanitizeStringArray(raw.whatWasChecked ?? [], seed),
    whatWasFound: sanitizeStringArray(raw.whatWasFound ?? raw.confirmedFacts ?? [], seed + 1),
    whatItMeans: sanitizeStringArray(raw.whatItMeans ?? [], seed + 2),
    whatRequiresManualReview: sanitizeStringArray(
      raw.whatRequiresManualReview ?? raw.manualReviewQueue ?? [],
      seed + 3
    ),
    excludedNoiseSummary: sanitizeStringArray(raw.excludedNoiseSummary ?? [], seed + 4),
    confirmedFacts: sanitizeStringArray(raw.confirmedFacts, seed + 5),
    unconfirmedSignals: sanitizeStringArray(raw.unconfirmedSignals, seed + 6),
    manualReviewQueue: sanitizeStringArray(raw.manualReviewQueue, seed + 7),
    recommendedActions: sanitizeStringArray(raw.recommendedActions, seed + 8),
    clientWarnings: sanitizeStringArray(raw.clientWarnings ?? [], seed + 9),
    evidenceExamples: (raw.evidenceExamples ?? []).map((e) => ({
      humanTitle: sanitizeClientNarrativeText(e.humanTitle),
      source: sanitizeClientNarrativeText(e.source),
      domain: sanitizeClientNarrativeText(e.domain),
      whyIncluded: sanitizeClientNarrativeText(e.whyIncluded),
      clientSafeStatus: e.clientSafeStatus,
    })),
    slidePlans: raw.slidePlans.map((p, i) => ({
      ...p,
      title: sanitizeClientNarrativeText(p.title),
      subtitle: p.subtitle ? sanitizeClientNarrativeText(p.subtitle) : undefined,
      clientTakeaway: sanitizeClientNarrativeText(p.clientTakeaway),
      bullets: p.bullets ? sanitizeStringArray(p.bullets, seed + 10 + i) : undefined,
    })),
  };

  const allText = [
    sanitized.executiveTakeaway,
    sanitized.clientExplanation,
    ...sanitized.confirmedFacts,
    ...sanitized.slidePlans.flatMap((p) => [p.clientTakeaway, ...(p.bullets ?? [])]),
  ].join("\n");
  const issues = assertNoClientHostileTokens(allText, raw.sectionKey);
  if (issues.length > 0) {
    sanitized.warnings = [...(sanitized.warnings ?? []), ...issues.slice(0, 5)];
  }
  return sanitized;
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
  return sanitizeGptStoryboardAnalysis({
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
  });
}

export function buildDeterministicStoryboardAnalysis(input: {
  sectionKey: GptStoryboardSectionKey;
  subjectName: string;
  evidence: NormalizedEvidenceV1[];
}): GptStoryboardSectionAnalysis {
  const rows = input.evidence.slice(0, 6);
  return sanitizeGptStoryboardAnalysis({
    sectionKey: input.sectionKey,
    generatedBy: "deterministic",
    executiveTakeaway: `Сводка по разделу ${STORYBOARD_SECTION_TITLES[input.sectionKey]} для ${input.subjectName}`,
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
              : input.sectionKey === "lexis_summary"
                ? "lexisnexis_summary"
                : input.sectionKey === "recommended_actions"
                  ? "recommended_actions"
                  : "search_overview",
        title: STORYBOARD_SECTION_TITLES[input.sectionKey],
        clientTakeaway: "Краткая клиентская сводка по доступным данным.",
        bullets: rows.slice(0, 4).map((e) => e.clientSafeSummary ?? e.title ?? "Источник"),
        evidenceRefs: rows.map((e) => e.evidenceRef),
      },
    ],
    warnings: ["deterministic-storyboard"],
  });
}

function parseGptResponse(cleaned: string): GptStoryboardSectionAnalysis {
  const parsed = validateGptStoryboardSectionAnalysis(JSON.parse(cleaned));
  const risk = normalizeRiskInterpretation(parsed.riskInterpretation as unknown);
  const merged = {
    ...parsed,
    riskInterpretation: risk.text,
    structuredRisk: parsed.riskInterpretationStructured ?? risk.structured,
    whatWasFound: parsed.whatWasFound ?? parsed.confirmedFacts,
    whatRequiresManualReview: parsed.whatRequiresManualReview ?? parsed.manualReviewQueue,
  } as GptStoryboardSectionAnalysis;
  return sanitizeGptStoryboardAnalysis({ ...merged, generatedBy: "gpt-5.5", warnings: [] });
}

export async function analyzeStoryboardSectionWithGpt55(input: {
  sectionKey: GptStoryboardSectionKey;
  subject: { displayName: string; locale: "ru" | "en" };
  evidence: NormalizedEvidenceV1[];
  classifiedEvidence?: ClassifiedEvidence[];
  assets: ReportAssetV1[];
  lexisMeta?: { parsedSignals: number; visualPages: number; uploadExists: boolean };
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
      return parseGptResponse(cleaned);
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

export async function runR912GptAnalyses(input: {
  caseContext: import("../orion-section-pipeline/real-case-data-adapter").OrionRealCaseContext;
  classifiedEvidence: ClassifiedEvidence[];
  assets: ReportAssetV1[];
  requireAi: boolean;
  allowDeterministicFallback: boolean;
}): Promise<GptStoryboardSectionAnalysis[]> {
  const {
    buildExecutiveEvidence,
    buildRuAuditSummaryEvidence,
    buildRuSearchEvidence,
  } = await import("../orion-report-spec/section-evidence-adapter");
  const subject = { displayName: input.caseContext.subject.fullName, locale: "ru" as const };
  const lexisMeta = {
    parsedSignals: input.caseContext.lexis.parsedSignals,
    visualPages: input.caseContext.lexis.visualPageCount,
    uploadExists: input.caseContext.lexis.uploadExists,
  };
  const keys: GptStoryboardSectionKey[] = [
    "executive_summary",
    "ru_audit_summary",
    "ru_search_results",
    "lexis_summary",
    "recommended_actions",
  ];
  const evidenceByKey: Record<GptStoryboardSectionKey, NormalizedEvidenceV1[]> = {
    executive_summary: buildExecutiveEvidence(input.caseContext),
    ru_audit_summary: buildRuAuditSummaryEvidence(input.caseContext),
    ru_search_results: buildRuSearchEvidence(input.caseContext),
    lexis_summary: input.classifiedEvidence
      .filter((c) => c.evidence.sourceKind === "lexisnexis" || c.evidence.sourceKind === "compliance")
      .map((c) => c.evidence),
    recommended_actions: buildExecutiveEvidence(input.caseContext),
  };

  const out: GptStoryboardSectionAnalysis[] = [];
  for (const sectionKey of keys) {
    const analysis = await analyzeStoryboardSectionWithGpt55({
      sectionKey,
      subject,
      evidence: evidenceByKey[sectionKey],
      classifiedEvidence: input.classifiedEvidence,
      assets: input.assets,
      lexisMeta: sectionKey === "lexis_summary" ? lexisMeta : undefined,
      requireAi: input.requireAi,
      allowDeterministicFallback: input.allowDeterministicFallback,
      maxOpenaiRetries: 6,
    });
    if (input.requireAi && !input.allowDeterministicFallback && analysis.generatedBy !== "gpt-5.5") {
      throw new Error(`live-signoff-non-gpt:${sectionKey}`);
    }
    out.push(analysis);
  }
  return out;
}
