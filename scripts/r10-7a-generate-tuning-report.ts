/**
 * R10.7a — Generate before/after threshold tuning comparison report.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CALIB = join(process.cwd(), "storage", "digital-profile", "qa-r10-7-real-subject-calibration");
const PARALLEL = join(process.cwd(), "storage", "digital-profile", "qa-r10-orion-golden-parallel");

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function countStatuses(analyses: Array<{ status: string }>): Record<string, number> {
  return analyses.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});
}

function main() {
  // Prefer calibration folder if present; else parallel (latest brain-only run)
  const afterRoot = existsSync(join(PARALLEL, "evidence-judgment-inspection.json"))
    ? PARALLEL
    : CALIB;
  const beforeReport = readJson<{
    evidenceDistribution: Record<string, number>;
    riskSignalDistribution: Record<string, number>;
    sectionStatusCounts: Record<string, number>;
    adminReview: { queueCount: number };
    contentQualityAssessment?: { emptySectionsToCollapse?: number };
  }>(join(CALIB, "r10-7-calibration-report.json"));

  const afterJudgment = readJson<{
    reviewDecisionCounts: Record<string, number>;
    riskSignalCounts: Record<string, number>;
    judgments: Array<{
      evidenceId: string;
      title: string;
      sourceDomain?: string;
      subjectBinding: string;
      sourceReliability: string;
      riskSignal: string;
      reviewDecision: string;
      contentNature: string;
      confidence: number;
      clientSafeSummary: string;
      manualReviewReason?: string;
      flags: string[];
    }>;
  }>(join(afterRoot, "evidence-judgment-inspection.json"));
  if (!afterJudgment) throw new Error(`missing after judgment at ${afterRoot}`);

  const afterAnalyses = readJson<{
    gptSectionCallCount: number;
    skippedSections: Array<{ reason: string }>;
    analyses: Array<{ status: string; sectionId: string }>;
  }>(join(afterRoot, "section-analyses/index.json"));
  const afterContent = readJson<{
    sections?: Array<{ sectionId: string; status: string; narrative: string; keyFindings: unknown[] }>;
    assemblySource: string;
  }>(join(afterRoot, "orion-client-content.pre-review.json"));
  const afterMd = existsSync(join(afterRoot, "orion-client-content.pre-review.md"))
    ? readFileSync(join(afterRoot, "orion-client-content.pre-review.md"), "utf-8")
    : "";
  const beforeMdPath = join(CALIB, "orion-client-content.pre-review.md");
  const beforeMd = existsSync(beforeMdPath) ? readFileSync(beforeMdPath, "utf-8") : "";
  const thresholdQa = readJson<{ verdict: string; passed: boolean; checks: unknown[]; issues: string[] }>(
    join(afterRoot, "r10-7a-threshold-tuning-qa.json")
  );
  const orchQa = readJson<{ verdict: string }>(join(afterRoot, "r10-6-section-gpt-orchestration-qa.json"));
  const diag = readJson<{ successfulCalls: number; failedCalls: number }>(
    join(afterRoot, "r10-6-gpt-runtime-diagnostics.json")
  );
  const queue = readJson<{ pendingCount: number }>(join(afterRoot, "manual-review-queue.json"));

  const beforeDecisions = beforeReport?.evidenceDistribution ?? {
    AUTO_INCLUDE_CLIENT_REPORT: 0,
    APPENDIX_ONLY: 655,
    MANUAL_REVIEW_REQUIRED: 66,
    EXCLUDE_NOISE: 7,
    EXCLUDE_WRONG_SUBJECT: 0,
  };
  const beforeRisk = beforeReport?.riskSignalDistribution ?? {
    INSUFFICIENT_CONTEXT: 490,
    NO_RISK_SIGNAL: 140,
    NEUTRAL_CONTEXT: 40,
    CONTROVERSIAL_DUAL_USE: 49,
    COMPLIANCE_RELEVANT: 4,
    POSSIBLE_ADVERSE: 4,
    POSITIVE_SIGNAL: 1,
    ADVERSE_CONFIRMED: 0,
  };
  const beforeStatuses = beforeReport?.sectionStatusCounts ?? {
    HAS_FINDINGS: 2,
    DATA_POOR: 20,
    MANUAL_REVIEW_PENDING: 15,
    NO_FINDINGS: 3,
  };

  const autoExamples = afterJudgment.judgments
    .filter((j) => j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT")
    .slice(0, 12)
    .map((j) => ({
      evidenceId: j.evidenceId,
      domain: j.sourceDomain,
      title: j.title.slice(0, 100),
      binding: j.subjectBinding,
      reliability: j.sourceReliability,
      risk: j.riskSignal,
      confidence: j.confidence,
      reason: j.clientSafeSummary.slice(0, 160),
    }));

  const stayedManual = afterJudgment.judgments
    .filter((j) => j.reviewDecision === "MANUAL_REVIEW_REQUIRED")
    .filter(
      (j) =>
        j.riskSignal === "CONTROVERSIAL_DUAL_USE" ||
        j.riskSignal === "COMPLIANCE_RELEVANT" ||
        j.riskSignal === "POSSIBLE_ADVERSE" ||
        j.flags.includes("compliance_db_potential_match")
    )
    .slice(0, 10)
    .map((j) => ({
      evidenceId: j.evidenceId,
      domain: j.sourceDomain,
      title: j.title.slice(0, 100),
      risk: j.riskSignal,
      why: j.manualReviewReason ?? "high-impact / compliance gate",
    }));

  const highImpactAuto = afterJudgment.judgments.filter(
    (j) =>
      j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT" &&
      ["CONTROVERSIAL_DUAL_USE", "POSSIBLE_ADVERSE", "COMPLIANCE_RELEVANT", "ADVERSE_CONFIRMED"].includes(
        j.riskSignal
      )
  );

  const exec01 = afterContent?.sections?.find((s) => s.sectionId === "01_executive_summary");
  const risk02 = afterContent?.sections?.find((s) => s.sectionId === "02_compliance_risk_matrix");
  const collapsedNote = afterContent?.sections?.find((s) => s.sectionId === "52_limitations_collapsed_note");

  const afterStatuses = afterAnalyses ? countStatuses(afterAnalyses.analyses) : {};
  const manualCount = afterJudgment.reviewDecisionCounts.MANUAL_REVIEW_REQUIRED ?? 0;
  const autoCount = afterJudgment.reviewDecisionCounts.AUTO_INCLUDE_CLIENT_REPORT ?? 0;

  let burden: "TOO_HIGH" | "ACCEPTABLE" | "TOO_LOW" = "ACCEPTABLE";
  if (highImpactAuto.length > 0 && manualCount < 10) burden = "TOO_LOW";
  else if (manualCount > 80) burden = "TOO_HIGH";
  else if (autoCount > 0 && manualCount <= 80) burden = "ACCEPTABLE";
  else if (autoCount === 0 && manualCount > 40) burden = "TOO_HIGH";

  let contentVerdict:
    | "CONTENT_BRAIN_BALANCED"
    | "STILL_TOO_STRICT"
    | "TOO_PERMISSIVE"
    | "BLOCKED_SAFETY_REGRESSION" = "CONTENT_BRAIN_BALANCED";
  if (highImpactAuto.length > 0) contentVerdict = "BLOCKED_SAFETY_REGRESSION";
  else if (autoCount === 0) contentVerdict = "STILL_TOO_STRICT";
  else if (autoCount > 200) contentVerdict = "TOO_PERMISSIVE";

  const report = {
    version: "r10-7a-threshold-tuning-report-v1",
    generatedAt: new Date().toISOString(),
    caseId: "cmqzz1vbr00d2vdrsrjsgie2g",
    subjectName: "Томилин Константин Романович",
    artifactRoots: { before: CALIB, after: afterRoot },
    before: {
      evidenceDecisions: beforeDecisions,
      riskSignals: beforeRisk,
      sectionStatuses: beforeStatuses,
      manualReviewQueue: beforeReport?.adminReview?.queueCount ?? 66,
      clientContentChars: beforeMd.length,
    },
    after: {
      evidenceDecisions: afterJudgment.reviewDecisionCounts,
      riskSignals: afterJudgment.riskSignalCounts,
      sectionStatuses: afterStatuses,
      manualReviewQueue: queue?.pendingCount ?? manualCount,
      clientContentChars: afterMd.length,
      gptSectionCallsSuccessful: diag?.successfulCalls ?? afterAnalyses?.gptSectionCallCount ?? null,
      gptSectionCallsFailed:
        afterAnalyses?.skippedSections.filter((s) => s.reason === "gpt_failed_fallback").length ?? null,
    },
    deltas: {
      autoInclude:
        (afterJudgment.reviewDecisionCounts.AUTO_INCLUDE_CLIENT_REPORT ?? 0) -
        (beforeDecisions.AUTO_INCLUDE_CLIENT_REPORT ?? 0),
      manualReview:
        (afterJudgment.reviewDecisionCounts.MANUAL_REVIEW_REQUIRED ?? 0) -
        (beforeDecisions.MANUAL_REVIEW_REQUIRED ?? 0),
      insufficientContext:
        (afterJudgment.riskSignalCounts.INSUFFICIENT_CONTEXT ?? 0) - (beforeRisk.INSUFFICIENT_CONTEXT ?? 0),
      dataPoorSections: (afterStatuses.DATA_POOR ?? 0) - (beforeStatuses.DATA_POOR ?? 0),
    },
    autoIncludeExamples: autoExamples,
    stayedManualReviewExamples: stayedManual,
    safetyRegressions: highImpactAuto.map((j) => ({
      evidenceId: j.evidenceId,
      risk: j.riskSignal,
      title: j.title.slice(0, 80),
    })),
    collapsedDataPoorNote: collapsedNote?.narrative ?? null,
    sections01_02: {
      executivePopulated: Boolean(exec01 && exec01.status !== "DATA_POOR" && exec01.narrative.length > 80),
      executiveStatus: exec01?.status ?? null,
      riskMatrixPopulated: Boolean(risk02 && risk02.status !== "DATA_POOR"),
      riskMatrixStatus: risk02?.status ?? null,
      riskMatrixFindings: risk02?.keyFindings?.length ?? 0,
    },
    thresholdTuningQa: thresholdQa,
    orchestrationQaVerdict: orchQa?.verdict ?? null,
    manualReviewBurden: burden,
    contentQualityVerdict: contentVerdict,
    finalVerdict: thresholdQa?.verdict ?? contentVerdict,
  };

  mkdirSync(CALIB, { recursive: true });
  const outPath = join(CALIB, "r10-7a-threshold-tuning-report.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  // Also copy beside after artifacts when different root
  if (afterRoot !== CALIB) {
    writeFileSync(join(afterRoot, "r10-7a-threshold-tuning-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  }
  console.log(`[OK] wrote ${outPath}`);
  console.log(
    JSON.stringify(
      {
        auto: autoCount,
        manual: manualCount,
        burden,
        contentVerdict,
        qa: thresholdQa?.verdict,
        exec01: report.sections01_02.executiveStatus,
        risk02: report.sections01_02.riskMatrixStatus,
      },
      null,
      2
    )
  );
}

main();
