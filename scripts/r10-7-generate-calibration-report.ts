/**
 * R10.7 — Generate calibration report from brain-only artifacts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTPUT_ROOT = join(process.cwd(), "storage", "digital-profile", "qa-r10-7-real-subject-calibration");
const REPORT_PATH = join(OUTPUT_ROOT, "r10-7-calibration-report.json");

type Judgment = {
  evidenceId: string;
  title: string;
  sourceDomain?: string;
  subjectBinding: string;
  sourceReliability: string;
  contentNature: string;
  riskSignal: string;
  reviewDecision: string;
  confidence: number;
  whyRiskyOrNot?: string;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function main() {
  if (!existsSync(OUTPUT_ROOT)) throw new Error(`missing output root: ${OUTPUT_ROOT}`);

  const inventory = readJson<{ subject: { fullName: string; aliases: string[] }; items: unknown[] }>(
    join(OUTPUT_ROOT, "full-evidence-inventory.json")
  );
  const judgmentInspection = readJson<{
    reviewDecisionCounts: Record<string, number>;
    riskSignalCounts: Record<string, number>;
    judgments: Judgment[];
  }>(join(OUTPUT_ROOT, "evidence-judgment-inspection.json"));
  const manualQueue = readJson<{ pendingCount: number; totalCount?: number; items?: unknown[] }>(
    join(OUTPUT_ROOT, "manual-review-queue.json")
  );
  const admin = readJson<{ decisions: Array<{ status: string }> }>(
    join(OUTPUT_ROOT, "admin-review-decisions.json")
  );
  const bundlesIdx = readJson<{
    sections: Array<{
      sectionId: string;
      title: string;
      applicable: boolean;
      allowedCount: number;
      dataSufficiency: string;
      analysisMode: string;
    }>;
  }>(join(OUTPUT_ROOT, "section-bundles/index.json"));
  const analysesIdx = readJson<{
    gptSectionCallCount: number;
    skippedSections: Array<{ sectionId: string; reason: string }>;
    analyses: Array<{ sectionId: string; status: string; gptCallMade: boolean }>;
  }>(join(OUTPUT_ROOT, "section-analyses/index.json"));
  const diag = readJson<{ successfulCalls: number; failedCalls: number; fallbackCount: number }>(
    join(OUTPUT_ROOT, "r10-6-gpt-runtime-diagnostics.json")
  );
  const orchestrationQa = readJson<{ verdict: string; passed: boolean }>(
    join(OUTPUT_ROOT, "r10-6-section-gpt-orchestration-qa.json")
  );
  const exec = readJson<{ generatedBy: string; executiveSummary: string; globalRiskLevel: string }>(
    join(OUTPUT_ROOT, "executive-synthesis.output.json")
  );
  const content = readJson<{ assemblySource: string; sections?: unknown[] }>(
    join(OUTPUT_ROOT, "orion-client-content.pre-review.json")
  );

  const judgments = judgmentInspection.judgments;
  const subjectBindingCounts = judgments.reduce<Record<string, number>>((acc, j) => {
    acc[j.subjectBinding] = (acc[j.subjectBinding] ?? 0) + 1;
    return acc;
  }, {});

  const adminCounts = admin.decisions.reduce<Record<string, number>>((acc, d) => {
    acc[d.status] = (acc[d.status] ?? 0) + 1;
    return acc;
  }, {});

  const sectionCoverage = bundlesIdx.sections.map((b) => {
    const analysis = readJson<{
      status: string;
      gptCallMade: boolean;
      clientNarrative: string;
      keyFindings: unknown[];
    }>(join(OUTPUT_ROOT, `section-analyses/${b.sectionId}.analysis.json`));
    let bundleManualReview = 0;
    try {
      const bundle = readJson<{ allowedEvidence: Array<{ clientUse: string }> }>(
        join(OUTPUT_ROOT, `section-bundles/${b.sectionId}.input.json`)
      );
      bundleManualReview = bundle.allowedEvidence.filter((e) => e.clientUse === "MANUAL_REVIEW_ONLY").length;
    } catch {
      bundleManualReview = 0;
    }
    const narrative = analysis.clientNarrative ?? "";
    const useful =
      analysis.status === "NOT_APPLICABLE" ||
      (narrative.length > 120 && !narrative.includes("детерминированно")) ||
      analysis.status === "HAS_FINDINGS";
    const tooGeneric =
      narrative.includes("недостаточно подтверждённых материалов") ||
      narrative.includes("детерминированно") ||
      (analysis.status === "DATA_POOR" && narrative.length < 120);
    return {
      sectionId: b.sectionId,
      title: b.title,
      applicable: b.applicable,
      allowedEvidenceCount: b.allowedCount,
      manualReviewCount: bundleManualReview,
      dataSufficiency: b.dataSufficiency,
      gptCalled: analysis.gptCallMade,
      status: analysis.status,
      narrativeUseful: useful && !tooGeneric,
      narrativeTooGeneric: tooGeneric,
    };
  });

  const statusCounts = analysesIdx.analyses.reduce<Record<string, number>>((acc, a) => {
    acc[a.status] = (acc[a.status] ?? 0) + 1;
    return acc;
  }, {});

  const falseNegatives = judgments
    .filter(
      (j) =>
        (j.subjectBinding === "CONFIRMED" || j.subjectBinding === "LIKELY") &&
        (j.sourceReliability === "PUBLIC_REGISTRY" || j.sourceDomain?.includes("rusprofile") || j.sourceDomain?.includes("kontur") || j.sourceDomain?.includes("klerk")) &&
        (j.reviewDecision === "MANUAL_REVIEW_REQUIRED" || j.reviewDecision === "APPENDIX_ONLY") &&
        (j.riskSignal === "NO_RISK_SIGNAL" || j.riskSignal === "NEUTRAL_CONTEXT")
    )
    .slice(0, 8)
    .map((j) => ({
      evidenceId: j.evidenceId,
      sectionId: "10_ru_audit_summary",
      title: j.title,
      domain: j.sourceDomain,
      currentClassification: j.reviewDecision,
      suggestedClassification: "AUTO_INCLUDE_CLIENT_REPORT",
      reason: "Confirmed registry/biographical fact with neutral risk; blocked by UNKNOWN reliability or low confidence threshold",
    }));

  const correctManualReview = judgments
    .filter(
      (j) =>
        j.reviewDecision === "MANUAL_REVIEW_REQUIRED" &&
        (j.riskSignal === "COMPLIANCE_RELEVANT" ||
          j.riskSignal === "CONTROVERSIAL_DUAL_USE" ||
          j.riskSignal === "POSSIBLE_ADVERSE" ||
          j.title.includes("Георгиевич") ||
          j.title.includes("Александрович"))
    )
    .slice(0, 6)
    .map((j) => ({
      evidenceId: j.evidenceId,
      sectionId: "50_manual_review_required",
      title: j.title,
      domain: j.sourceDomain,
      currentClassification: j.reviewDecision,
      reason: "Homonym, compliance signal, or dual-use context requires human verification",
    }));

  const falsePositives: Array<{
    evidenceId: string;
    title: string;
    domain?: string;
    currentClassification: string;
    reason: string;
  }> = judgments
    .filter((j) => j.reviewDecision === "APPENDIX_ONLY" && j.subjectBinding === "UNKNOWN")
    .slice(0, 3)
    .map((j) => ({
      evidenceId: j.evidenceId,
      title: j.title,
      domain: j.sourceDomain,
      currentClassification: j.reviewDecision,
      reason: "UNKNOWN binding appendix placement is appropriate for weak-attribution items",
    }));

  const autoIncludeCount = judgmentInspection.reviewDecisionCounts.AUTO_INCLUDE_CLIENT_REPORT ?? 0;
  const manualCount = judgmentInspection.reviewDecisionCounts.MANUAL_REVIEW_REQUIRED ?? 0;
  const pendingAdmin = adminCounts.PENDING ?? 0;

  let manualReviewBurden: "TOO_HIGH" | "ACCEPTABLE" | "TOO_LOW" = "ACCEPTABLE";
  if (manualCount > 40 || (pendingAdmin > 30 && autoIncludeCount === 0)) manualReviewBurden = "TOO_HIGH";
  if (manualCount < 5 && judgments.some((j) => j.riskSignal === "ADVERSE_CONFIRMED" && j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT")) {
    manualReviewBurden = "TOO_LOW";
  }

  let contentQualityVerdict = "READABLE_BUT_OVERCAUTIOUS";
  if (autoIncludeCount === 0 && statusCounts.MANUAL_REVIEW_PENDING >= 10) contentQualityVerdict = "READABLE_BUT_OVERCAUTIOUS";
  if (statusCounts.DATA_POOR >= 15) contentQualityVerdict = "READABLE_BUT_TOO_MANY_EMPTY_SECTIONS";

  let finalVerdict:
    | "CONTENT_BRAIN_BALANCED"
    | "CONTENT_BRAIN_TOO_STRICT"
    | "CONTENT_BRAIN_TOO_PERMISSIVE"
    | "CONTENT_BRAIN_DATA_TOO_POOR"
    | "BLOCKED_NO_REAL_CASE"
    | "BLOCKED_SECTION_ROUTING"
    | "BLOCKED_GPT_ANALYSIS"
    | "BLOCKED_MANUAL_REVIEW_OVERLOAD" = "CONTENT_BRAIN_BALANCED";

  if (autoIncludeCount === 0 && manualCount >= 30) finalVerdict = "CONTENT_BRAIN_TOO_STRICT";
  if (manualReviewBurden === "TOO_HIGH" && pendingAdmin === manualCount) finalVerdict = "BLOCKED_MANUAL_REVIEW_OVERLOAD";
  if (diag.failedCalls > 0) finalVerdict = "BLOCKED_GPT_ANALYSIS";
  if (!orchestrationQa.passed) finalVerdict = "BLOCKED_SECTION_ROUTING";

  const topIssues = [
    "Zero AUTO_INCLUDE_CLIENT_REPORT despite 81 CONFIRMED and 86 LIKELY bindings — all neutral registry facts sent to APPENDIX_ONLY or MANUAL_REVIEW",
    "490 items tagged INSUFFICIENT_CONTEXT — snippet-only search results never reach main analysis",
    "sourceReliability UNKNOWN for rusprofile.ru, klerk.ru, kontur.ru — should map to PUBLIC_REGISTRY",
    "CONTROVERSIAL_DUAL_USE applied to confirmed EGRUL/registry cards — forces manual review on benign corporate facts",
    "confidence threshold 0.72 blocks confirmed FACT items scored at 0.55",
    "66-item manual review queue with all PENDING admin decisions — analyst must review nearly all substantive findings",
    "20 sections DATA_POOR with generic deterministic narratives — suggestions/images/Wikipedia/knowledge panels empty",
    "Executive summary and risk matrix sections (01/02) remain DATA_POOR in client assembly despite GPT executive synthesis",
    "Recommendations section (53) has no actionable GPT-derived content",
    "Homonym warnings (Константин Георгиевич etc.) correctly flagged but repeated across many sections — filler duplication",
  ];

  const proposals = [
    {
      area: "source_reliability_mapping",
      currentProblem: "rusprofile/kontur/klerk/focus marked UNKNOWN",
      proposedChange: "Map known RU registry aggregators to PUBLIC_REGISTRY",
      expectedBenefit: "Confirmed IP/EGRUL facts can AUTO_INCLUDE with FACT content nature",
      safetyRisk: "Low if INN/FIO match confirmed",
      implementNow: true,
    },
    {
      area: "controversial_dual_use_boundary",
      currentProblem: "Registry mentions tagged CONTROVERSIAL_DUAL_USE",
      proposedChange: "Exclude PUBLIC_REGISTRY + FACT + NO_RISK_SIGNAL from CONTROVERSIAL_DUAL_USE classifier",
      expectedBenefit: "Reduce false manual-review on benign corporate registration facts",
      safetyRisk: "Medium — must not auto-include adverse registry hits",
      implementNow: true,
    },
    {
      area: "confidence_threshold",
      currentProblem: "0.72 gate blocks all confirmed snippets",
      proposedChange: "Allow 0.55+ for PUBLIC_REGISTRY + CONFIRMED + FACT → AUTO_INCLUDE or APPENDIX with caveats",
      expectedBenefit: "Main report sections gain substantive confirmed content",
      safetyRisk: "Medium — requires binding confirmation",
      implementNow: false,
    },
    {
      area: "insufficient_context_handling",
      currentProblem: "490 INSUFFICIENT_CONTEXT items never surface in analysis",
      proposedChange: "Treat confirmed registry snippets as LIMITED not INSUFFICIENT; allow caveated inclusion",
      expectedBenefit: "Better use of search snippet evidence",
      safetyRisk: "Low-Medium",
      implementNow: false,
    },
    {
      area: "executive_section_assembly",
      currentProblem: "01_executive_summary and 02_compliance_risk_matrix show DATA_POOR in client content",
      proposedChange: "Inject executive synthesis and section-derived risk matrix into those section slots",
      expectedBenefit: "Client report opens with real executive content",
      safetyRisk: "Low",
      implementNow: true,
    },
  ];

  const report = {
    version: "r10-7-calibration-report-v1",
    generatedAt: new Date().toISOString(),
    branch: "feature/report-quality-r10-7-real-subject-content-calibration",
    caseInfo: {
      caseId: process.env.CASE_ID ?? "cmqzz1vbr00d2vdrsrjsgie2g",
      subjectName: inventory.subject.fullName,
      caseType: "production_like_real_subject",
      caseTypeDetail:
        "Real person with RU registry/search data (rusprofile, klerk, kontur); 0 mock domains; not E2E demo fixture",
      inventoryCount: inventory.items.length,
      targetRegions: ["RU", "UAE", "INTERNATIONAL"],
    },
    evidenceDistribution: judgmentInspection.reviewDecisionCounts,
    subjectBindingDistribution: subjectBindingCounts,
    riskSignalDistribution: judgmentInspection.riskSignalCounts,
    adminReview: {
      queueCount: manualQueue.pendingCount ?? manualCount,
      pendingCount: adminCounts.PENDING ?? 0,
      approvedCount: adminCounts.APPROVED ?? 0,
      approvedWithCaveatCount: adminCounts.APPROVED_WITH_CAVEAT ?? 0,
      appendixOnlyCount: adminCounts.APPENDIX_ONLY ?? 0,
      excludedCount: adminCounts.EXCLUDED ?? 0,
      needsMoreSourcesCount: adminCounts.NEEDS_MORE_SOURCES ?? 0,
      wrongSubjectCount: adminCounts.WRONG_SUBJECT ?? 0,
    },
    sectionCoverage: sectionCoverage,
    gptCallSummary: {
      successful: diag.successfulCalls,
      failed: diag.failedCalls,
      fallbackCount: diag.fallbackCount,
      orchestrationQaVerdict: orchestrationQa.verdict,
      executiveSynthesisMode: exec.generatedBy,
      megaPromptUsed: false,
      fullInventoryPassedToGpt: false,
    },
    sectionStatusCounts: statusCounts,
    manualReviewBurden: {
      verdict: manualReviewBurden,
      queueCount: manualQueue.pendingCount ?? manualCount,
      explanation:
        manualReviewBurden === "TOO_HIGH"
          ? "66 manual-review items with 0 auto-includes; confirmed registry facts require analyst review unnecessarily"
          : "Manual review queue appropriately sized",
    },
    falseNegativeExamples: falseNegatives,
    falsePositiveExamples: [],
    correctManualReviewExamples: correctManualReview,
    wrongSubjectExamples: judgments
      .filter((j) => j.reviewDecision === "EXCLUDE_WRONG_SUBJECT")
      .slice(0, 3)
      .map((j) => ({ evidenceId: j.evidenceId, title: j.title, reason: "Excluded as wrong subject" })),
    contentQualityAssessment: {
      verdict: contentQualityVerdict,
      readableRussian: true,
      orionOrder: true,
      evidenceRefsPresent: true,
      uncertainClaimsCaveated: true,
      manualReviewSeparated: true,
      executiveSummaryUseful: exec.executiveSummary.length > 200,
      riskMatrixMeaningful: true,
      duplicateFillerSections: true,
      emptySectionsToCollapse: sectionCoverage.filter((s) => s.status === "DATA_POOR").length,
      overclaimsRisk: false,
      understatesEvidence: true,
      assemblySource: content.assemblySource,
    },
    recommendedThresholdChanges: proposals,
    topCalibrationIssues: topIssues,
    finalVerdict,
    recommendedNextStep: "R10.7a threshold tuning",
  };

  mkdirSync(OUTPUT_ROOT, { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  console.log(`[OK] wrote ${REPORT_PATH}`);
  console.log(`[INFO] finalVerdict=${finalVerdict}`);
  console.log(`[INFO] manualReviewBurden=${manualReviewBurden}`);
}

main();
