import type { AiAnalystNarrative, ReportJson } from "../types";
import type { OrionReportSectionKey, SectionAnalysisResult } from "./report-spec-schema";

export interface LegacyGptNarrativeInjectionInput {
  legacyReportJson: ReportJson;
  sectionAnalyses: SectionAnalysisResult[];
}

export interface LegacyGptNarrativeInjectionResult {
  reportJson: ReportJson;
  injectedSections: OrionReportSectionKey[];
  generatedBy: "gpt-5.5" | "deterministic" | "mixed";
}

function analysisMap(analyses: SectionAnalysisResult[]): Map<OrionReportSectionKey, SectionAnalysisResult> {
  return new Map(analyses.map((a) => [a.sectionKey, a]));
}

function allGeneratedBy(analyses: SectionAnalysisResult[]): "gpt-5.5" | "deterministic" | "mixed" {
  const modes = new Set(analyses.map((a) => a.generatedBy));
  if (modes.size === 1) return modes.values().next().value as "gpt-5.5" | "deterministic";
  return "mixed";
}

function buildAiAnalystFromSections(analyses: SectionAnalysisResult[], language: "ru" | "en"): AiAnalystNarrative {
  const byKey = analysisMap(analyses);
  const exec = byKey.get("executive_summary")?.section.clientNarrative;
  const ruAudit = byKey.get("ru_audit_summary")?.section.clientNarrative;
  const ruSearch = byKey.get("ru_search_results")?.section.clientNarrative;
  const generatedBy = allGeneratedBy(analyses);

  return {
    status: generatedBy === "gpt-5.5" ? "ready" : "fallback",
    generatedBy: generatedBy === "mixed" ? "deterministic" : generatedBy,
    provider: generatedBy === "gpt-5.5" ? "openai" : "none",
    language,
    generatedAt: new Date().toISOString(),
    meta: {
      evidenceItemsUsed: analyses.reduce((n, a) => n + a.section.evidenceHighlights.length, 0),
      truncatedInput: false,
      warnings: analyses.flatMap((a) => a.warnings),
    },
    executiveSummary: {
      plainConclusion: exec?.headline ?? exec?.summary ?? "",
      riskExplanation: exec?.riskInterpretation ?? exec?.whyItMatters ?? "",
      whyNotLow: exec?.whyItMatters ?? "",
      whatWasFound: exec?.whatWasFound ?? [],
      whatWasNotConfirmed: exec?.whatWasNotConfirmed ?? [],
      manualReviewRequired: exec?.manualReviewQueue ?? [],
      nextActions: exec?.recommendedNextSteps ?? [],
    },
    regionNarratives: {
      ru: {
        confirmedNegativeSummary: ruAudit?.whatWasFound?.join(" ") ?? "",
        potentialNegativeSummary: ruAudit?.riskInterpretation ?? "",
        reviewRequiredSummary: ruAudit?.manualReviewQueue?.join(" ") ?? "",
        topThemes: [],
        keyDomains: [],
        riskExplanation: ruSearch?.riskInterpretation ?? ruAudit?.summary ?? "",
        recommendedActions: [
          ...(ruAudit?.recommendedNextSteps ?? []),
          ...(ruSearch?.recommendedNextSteps ?? []),
        ].slice(0, 6),
        sanctionsWatchlistContext: ruSearch?.whatWasFound?.find((x) => /санкц/i.test(x)) ?? undefined,
      },
    },
    evidenceInterpretation: {
      confirmed: (exec?.whatWasFound ?? []).slice(0, 4).join(" "),
      reviewRequired: (exec?.manualReviewQueue ?? []).slice(0, 4).join(" "),
      excludedNoise: (exec?.whatWasNotConfirmed ?? []).slice(0, 3).join(" "),
      confidence: exec?.summary ?? "",
    },
    clientSafeWarnings: [],
  };
}

/** Inject GPT section narratives into legacy report_json without altering visual structure. */
export function injectGptNarrativesIntoLegacyReportVm(
  input: LegacyGptNarrativeInjectionInput
): LegacyGptNarrativeInjectionResult {
  const reportJson = structuredClone(input.legacyReportJson) as ReportJson;
  const byKey = analysisMap(input.sectionAnalyses);
  const language = (reportJson.reportLanguage ?? reportJson.meta?.language ?? "ru") as "ru" | "en";

  reportJson.aiAnalystNarrative = buildAiAnalystFromSections(input.sectionAnalyses, language);

  if (reportJson.auditSummary) {
    const exec = byKey.get("executive_summary")?.section.clientNarrative;
    const ruAudit = byKey.get("ru_audit_summary")?.section.clientNarrative;
    const ruSearch = byKey.get("ru_search_results")?.section.clientNarrative;

    if (exec) {
      const bullets = [
        exec.summary,
        exec.riskInterpretation,
        ...exec.whatWasFound.slice(0, 3),
        ...exec.manualReviewQueue.slice(0, 2),
      ].filter(Boolean);
      reportJson.auditSummary.executiveSummary = bullets.slice(0, 6);
      reportJson.auditSummary.recommendedActions = exec.recommendedNextSteps.slice(0, 6);
    }

    const ruRegion = reportJson.auditSummary.regions.find((r) => r.region === "RU");
    if (ruRegion) {
      if (ruAudit?.summary) {
        ruRegion.regionConclusion = ruAudit.summary;
      }
      if (ruSearch?.summary && ruSearch.summary !== ruAudit?.summary) {
        ruRegion.regionConclusion = [ruRegion.regionConclusion, ruSearch.summary].filter(Boolean).join(" ");
      }
    }
  }

  return {
    reportJson,
    injectedSections: input.sectionAnalyses.map((a) => a.sectionKey),
    generatedBy: allGeneratedBy(input.sectionAnalyses),
  };
}
