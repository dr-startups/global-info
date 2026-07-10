import { z } from "zod";
import type { ReportAssetV1 } from "./asset-builder";
export type { ReportAssetV1 } from "./asset-builder";
import type { NormalizedEvidenceV1 } from "./normalized-evidence";

export type OrionReportSectionKey = "executive_summary" | "ru_audit_summary" | "ru_search_results";

export type OrionSlideTemplate =
  | "orion_executive_summary"
  | "orion_section_summary"
  | "orion_serp_screenshot"
  | "orion_evidence_explanation";

export type OrionSlideSpecV1 = {
  slideKey: string;
  template: OrionSlideTemplate;
  title: string;
  subtitle?: string;
  narrative?: string;
  bullets?: string[];
  metricRefs?: string[];
  evidenceRefs?: string[];
  assetRefs?: string[];
};

export type OrionReportSectionSpecV1 = {
  sectionKey: OrionReportSectionKey;
  title: string;
  subtitle?: string;
  clientNarrative: {
    headline: string;
    summary: string;
    whatWasFound: string[];
    whatWasNotConfirmed: string[];
    whyItMatters: string;
    riskInterpretation: string;
    manualReviewQueue: string[];
    recommendedNextSteps: string[];
  };
  metrics: Array<{
    label: string;
    value: string | number;
    tone?: "neutral" | "low" | "medium" | "high" | "warning";
  }>;
  evidenceHighlights: Array<{
    label: string;
    summary: string;
    evidenceRef: string;
    status: string;
  }>;
  slides: OrionSlideSpecV1[];
};

export type OrionReportSpecV1 = {
  version: "orion-report-spec-v1";
  subject: {
    displayName: string;
    locale: "ru" | "en";
    generatedAt: string;
  };
  sections: OrionReportSectionSpecV1[];
  assets: ReportAssetV1[];
  evidence: NormalizedEvidenceV1[];
  qa: {
    generatedBy: "gpt-5.5" | "deterministic";
    requiredAi: boolean;
    forbiddenClientTerms: string[];
    warnings: string[];
  };
};

const slideSpecSchema = z.object({
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
});

const sectionSpecSchema = z.object({
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
  slides: z.array(slideSpecSchema).min(1),
});

export const orionReportSpecV1Schema = z.object({
  version: z.literal("orion-report-spec-v1"),
  subject: z.object({
    displayName: z.string().min(1),
    locale: z.enum(["ru", "en"]),
    generatedAt: z.string().min(1),
  }),
  sections: z.array(sectionSpecSchema).min(1),
  assets: z.array(
    z.object({
      assetRef: z.string(),
      kind: z.enum([
        "synthetic_serp",
        "captured_serp",
        "image_grid",
        "video_cards",
        "knowledge_panel",
        "surface_panel",
        "lexis_visual_page",
        "compliance_visual_page",
      ]),
      title: z.string(),
      caption: z.string().optional(),
      imageData: z.string().optional(),
      imageUrl: z.string().optional(),
      evidenceRefs: z.array(z.string()),
      status: z.enum(["ready", "missing"]),
    })
  ),
  evidence: z.array(z.any()),
  qa: z.object({
    generatedBy: z.enum(["gpt-5.5", "deterministic"]),
    requiredAi: z.boolean(),
    forbiddenClientTerms: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
});

export function validateOrionReportSpecV1(spec: unknown): OrionReportSpecV1 {
  return orionReportSpecV1Schema.parse(spec) as OrionReportSpecV1;
}

export const SECTION_TITLES: Record<OrionReportSectionKey, string> = {
  executive_summary: "Executive Summary",
  ru_audit_summary: "Россия 2.1 — Сводка аудита",
  ru_search_results: "Россия 2.2 — Поисковая выдача",
};

export type SectionAnalysisResult = {
  sectionKey: OrionReportSectionKey;
  generatedBy: "gpt-5.5" | "deterministic";
  section: OrionReportSectionSpecV1;
  warnings: string[];
};
