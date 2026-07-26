/**
 * R10.4 — Gate evidence for GPT and client content generation.
 */

import type { EvidenceDecisionRecord, SectionEvidencePack } from "../types";
import type { EvidenceJudgment, ReviewDecision } from "./evidence-judgment";

export type GatedEvidenceBundle = {
  evidenceId: string;
  title: string;
  domain?: string;
  clientSafeSummary: string;
  reviewDecision: ReviewDecision;
  gptTier: "approved" | "appendix_caveated" | "manual_review_pending" | "excluded";
  riskSignal: EvidenceJudgment["riskSignal"];
  subjectBinding: EvidenceJudgment["subjectBinding"];
  flags: string[];
};

export type EvidenceBundlesArtifact = {
  version: "r10-4-evidence-bundles-v1";
  caseId: string;
  reportRunId: string;
  counts: Record<ReviewDecision, number>;
  autoInclude: GatedEvidenceBundle[];
  appendixOnly: GatedEvidenceBundle[];
  manualReview: GatedEvidenceBundle[];
  excluded: GatedEvidenceBundle[];
};

function toGptTier(decision: ReviewDecision): GatedEvidenceBundle["gptTier"] {
  switch (decision) {
    case "AUTO_INCLUDE_CLIENT_REPORT":
      return "approved";
    case "APPENDIX_ONLY":
      return "appendix_caveated";
    case "MANUAL_REVIEW_REQUIRED":
      return "manual_review_pending";
    default:
      return "excluded";
  }
}

export function buildGatedEvidenceBundles(input: {
  caseId: string;
  reportRunId: string;
  judgments: EvidenceJudgment[];
}): EvidenceBundlesArtifact {
  const autoInclude: GatedEvidenceBundle[] = [];
  const appendixOnly: GatedEvidenceBundle[] = [];
  const manualReview: GatedEvidenceBundle[] = [];
  const excluded: GatedEvidenceBundle[] = [];
  const counts: Record<string, number> = {};

  for (const j of input.judgments) {
    counts[j.reviewDecision] = (counts[j.reviewDecision] ?? 0) + 1;
    const bundle: GatedEvidenceBundle = {
      evidenceId: j.evidenceId,
      title: j.title,
      domain: j.sourceDomain,
      clientSafeSummary: j.clientSafeSummary,
      reviewDecision: j.reviewDecision,
      gptTier: toGptTier(j.reviewDecision),
      riskSignal: j.riskSignal,
      subjectBinding: j.subjectBinding,
      flags: j.flags,
    };
    switch (j.reviewDecision) {
      case "AUTO_INCLUDE_CLIENT_REPORT":
        autoInclude.push(bundle);
        break;
      case "APPENDIX_ONLY":
        appendixOnly.push(bundle);
        break;
      case "MANUAL_REVIEW_REQUIRED":
        manualReview.push(bundle);
        break;
      default:
        excluded.push(bundle);
    }
  }

  return {
    version: "r10-4-evidence-bundles-v1",
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    counts: counts as Record<ReviewDecision, number>,
    autoInclude,
    appendixOnly,
    manualReview,
    excluded,
  };
}

/** Apply judgment gating to relevance decisions before routing / GPT. */
export function applyJudgmentToDecisions(
  decisions: EvidenceDecisionRecord[],
  judgmentById: Map<string, EvidenceJudgment>
): EvidenceDecisionRecord[] {
  return decisions.map((d) => {
    const j = judgmentById.get(d.inventoryId);
    if (!j) return d;

    let includeInClientReport = false;
    let includeInAppendix = false;

    switch (j.reviewDecision) {
      case "AUTO_INCLUDE_CLIENT_REPORT":
        includeInClientReport = true;
        break;
      case "APPENDIX_ONLY":
        includeInAppendix = true;
        break;
      case "MANUAL_REVIEW_REQUIRED":
        includeInClientReport = false;
        includeInAppendix = false;
        break;
      case "EXCLUDE_NOISE":
      case "EXCLUDE_WRONG_SUBJECT":
        includeInClientReport = false;
        includeInAppendix = false;
        break;
    }

    return {
      ...d,
      includeInClientReport,
      includeInAppendix,
      humanReason: j.clientSafeSummary || d.humanReason,
      confidence: j.confidence,
    };
  });
}

export function filterPacksForGpt(packs: SectionEvidencePack[], judgmentById: Map<string, EvidenceJudgment>): SectionEvidencePack[] {
  return packs.map((pack) => {
    const filterSelected = (records: EvidenceDecisionRecord[]) =>
      records.filter((r) => {
        const j = judgmentById.get(r.inventoryId);
        if (!j) return r.includeInClientReport;
        return (
          j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT" ||
          j.reviewDecision === "APPENDIX_ONLY" ||
          j.reviewDecision === "MANUAL_REVIEW_REQUIRED"
        );
      });

    const selectedForAnalysis = filterSelected(pack.selectedForAnalysis).map((r) => {
      const j = judgmentById.get(r.inventoryId);
      if (!j) return r;
      return {
        ...r,
        humanReason:
          j.reviewDecision === "MANUAL_REVIEW_REQUIRED"
            ? `[ТРЕБУЕТ РУЧНОЙ ПРОВЕРКИ — НЕ ПОДТВЕРЖДЕНО] ${j.clientSafeSummary}`
            : j.reviewDecision === "APPENDIX_ONLY"
              ? `[ПРИЛОЖЕНИЕ — ОГРАНИЧЕННЫЙ ВЫВОД] ${j.clientSafeSummary}`
              : j.clientSafeSummary,
      };
    });

    const selectedForDisplay = selectedForAnalysis.filter((r) => {
      const j = judgmentById.get(r.inventoryId);
      return j?.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT";
    });

    return {
      ...pack,
      selectedForAnalysis,
      selectedForDisplay,
      selectedCount: selectedForAnalysis.length,
      metrics: {
        ...pack.metrics,
        gatedApproved: selectedForDisplay.length,
        gatedManualReview: selectedForAnalysis.filter(
          (r) => judgmentById.get(r.inventoryId)?.reviewDecision === "MANUAL_REVIEW_REQUIRED"
        ).length,
      },
    };
  });
}
