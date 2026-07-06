import { z } from "zod";
import type { ClientStoryboard } from "./types";

const slideTypeSchema = z.enum([
  "cover",
  "global_toc",
  "executive_summary",
  "risk_matrix",
  "region_summary",
  "search_overview",
  "serp_screenshot",
  "search_results_table",
  "adverse_media_summary",
  "image_grid",
  "video_cards",
  "knowledge_panel",
  "wikipedia_summary",
  "compliance_summary",
  "lexisnexis_summary",
  "lexisnexis_visual_page",
  "evidence_appendix",
  "recommended_actions",
  "commercial_offer",
  "about",
  "no_data_compact",
]);

export const gptStoryboardSectionAnalysisSchema = z.object({
  sectionKey: z.enum(["executive_summary", "ru_audit_summary", "ru_search_results"]),
  /** Injected after GPT parse; not returned by the model. */
  generatedBy: z.enum(["gpt-5.5", "deterministic"]).optional(),
  executiveTakeaway: z.string().min(1),
  clientExplanation: z.string().min(1),
  riskInterpretation: z.string().min(1),
  confirmedFacts: z.array(z.string()),
  unconfirmedSignals: z.array(z.string()),
  manualReviewQueue: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  slidePlans: z.array(
    z.object({
      slideKey: z.string().min(1),
      slideType: slideTypeSchema,
      title: z.string().min(1),
      subtitle: z.string().optional(),
      clientTakeaway: z.string().min(1),
      bullets: z.array(z.string()).max(5).optional(),
      evidenceRefs: z.array(z.string()).optional(),
      assetRefs: z.array(z.string()).optional(),
    })
  ),
  warnings: z.array(z.string()).default([]),
});

const clientStoryboardSchema = z.object({
  version: z.literal("orion-client-storyboard-v1"),
  subject: z.object({ displayName: z.string(), locale: z.enum(["ru", "en"]) }),
  generatedAt: z.string(),
  sections: z.array(z.any()),
  slides: z.array(
    z.object({
      slideId: z.string(),
      sectionKey: z.string(),
      slideType: slideTypeSchema,
      title: z.string(),
      clientTakeaway: z.string(),
      metrics: z.array(z.any()),
      findings: z.array(z.any()),
      evidenceRefs: z.array(z.any()),
      assetRefs: z.array(z.any()),
      recommendedActions: z.array(z.any()),
      riskLevel: z.enum(["low", "medium", "high", "unknown"]),
      layoutIntent: z.string(),
      omitIfNoData: z.boolean(),
      visualDensityTarget: z.enum(["compact", "standard", "rich"]),
    })
  ),
  qa: z.object({
    generatedBy: z.enum(["gpt-5.5", "deterministic", "mixed"]),
    requireAi: z.boolean(),
    realCaseQualityEligible: z.boolean(),
    caseId: z.string(),
    caseSource: z.enum(["env", "db", "fixture"]),
    warnings: z.array(z.string()),
  }),
});

export function validateClientStoryboard(raw: unknown): ClientStoryboard {
  return clientStoryboardSchema.parse(raw) as ClientStoryboard;
}

export function validateGptStoryboardSectionAnalysis(raw: unknown) {
  return gptStoryboardSectionAnalysisSchema.parse(raw);
}

/** Client-visible forbidden patterns for R9.9 QA. */
export const FORBIDDEN_CLIENT_LABELS = [
  "mock",
  "fallback",
  "provider",
  "runtime",
  "debug",
  "manifest",
  "micro-stage",
  "ORION_STATIC",
  "COMMERCIAL_CONTEXT",
  "compliance_db_correction",
  "adverse_media",
  "pep",
  "PRESENT",
  "UNKNOWN",
  "NOT_COLLECTED",
  "preserved in evidence",
  "more items preserved",
  "example.com",
  "example.ru",
  "OPENAI_API_KEY",
  "storage/digital-profile",
  "Поле / Значение",
] as const;

export function scanStoryboardClientText(text: string): string[] {
  const issues: string[] = [];
  const lower = text.toLowerCase();
  for (const term of FORBIDDEN_CLIENT_LABELS) {
    if (lower.includes(term.toLowerCase())) issues.push(`forbidden:${term}`);
  }
  if (/\+ \d+ more items/i.test(text)) issues.push("forbidden:+more-items");
  return issues;
}
