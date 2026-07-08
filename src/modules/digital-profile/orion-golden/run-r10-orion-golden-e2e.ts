/**
 * R10 — ORION Golden real-case E2E pipeline (3-layer architecture).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness, digitalProfileConfig } from "../config";
import { OpenAiRateLimitError } from "../orion-report-spec/openai-rate-limit";
import { loadRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";
import { ORION_GOLDEN_ARCHITECTURE } from "./architecture/orion-agent-architecture";
import { ORION_GOLDEN_BLUEPRINT } from "./blueprint/orion-golden-blueprint";
import { buildOrionGoldenAssets } from "./assets/orion-asset-builder";
import { composeOrionGoldenDeck } from "./composer/orion-deck-composer";
import {
  assembleOrionClientContentFromSections,
  buildOrionClientContent,
  renderOrionClientContentMarkdown,
} from "./content/orion-client-content-builder";
import { buildOrionGoldenSupabaseSchemaPlan } from "./db/orion-supabase-schema-plan";
import { buildAdminReviewSampleFixture } from "./evidence/admin-review-sample-fixture";
import {
  ensureAdminReviewDecisions,
  saveAdminReviewSampleFixture,
} from "./evidence/admin-review-decision-store";
import { countAdminDecisionsByStatus } from "./evidence/admin-review-decision";
import { buildFullEvidenceInventory } from "./evidence/full-evidence-inventory";
import {
  applyJudgmentToDecisions,
  buildGatedEvidenceBundles,
  filterPacksForGpt,
} from "./evidence/evidence-client-gate";
import { buildAllEvidenceJudgments } from "./evidence/evidence-judgment-builder";
import { countByReviewDecision, countByRiskSignal } from "./evidence/evidence-judgment";
import { buildManualReviewQueue } from "./evidence/manual-review-queue";
import { routeEvidenceToSections, validateRoutingAgainstBlueprint } from "./evidence/orion-section-router";
import { classifyInventoryRelevance } from "./evidence/relevance-classifier";
import { runOrionGoldenExecutiveSynthesis } from "./gpt/orion-executive-synthesizer";
import {
  buildExecutiveSynthesisFromSections,
  buildExecutiveSynthesisInput,
  buildDeterministicExecutiveFallback,
} from "./gpt/orion-executive-synthesis-from-sections";
import { analyzeOrionSections } from "./gpt/orion-section-analysis-orchestrator";
import { runOrionGoldenSectionAnalyses } from "./gpt/orion-section-analyzer";
import { inspectOrionGoldenClientPolicy } from "./qa/client-policy-inspection";
import { inspectContentQualityReview } from "./qa/r10-4-content-quality-review";
import { inspectEvidenceJudgmentQa } from "./qa/r10-4-evidence-judgment-qa";
import { inspectAdminReviewWorkflowQa } from "./qa/r10-5-admin-review-workflow-qa";
import { inspectSectionGptOrchestrationQa } from "./qa/r10-6-section-gpt-orchestration-qa";
import { inspectThresholdTuningQa } from "./qa/r10-7a-threshold-tuning-qa";
import { buildOrionSectionBundles, countInventoryRegions } from "./sections/orion-section-bundle-builder";
import type { OrionSectionBundleIndex } from "./sections/orion-section-bundle";
import type { OrionSectionAnalysisIndex } from "./sections/orion-section-analysis";
import { buildRiskMatrixFromSections } from "./sections/orion-risk-matrix-from-sections";
import { getClientAuditSections } from "./sections/orion-section-registry";
import { inspectOrionGoldenVisualQuality } from "./qa/visual-qa-inspection";
import { renderOrionGoldenArtifacts } from "./renderer/orion-golden-render-client";
import { buildOrionGoldenReportSpec } from "./report-spec/orion-report-spec";
import type { OrionGoldenQaVerdict } from "./types";

function writeSectionBundleArtifacts(outputRoot: string, bundles: Awaited<ReturnType<typeof buildOrionSectionBundles>>, caseId: string, reportRunId: string): void {
  const bundlesDir = join(outputRoot, "section-bundles");
  mkdirSync(bundlesDir, { recursive: true });
  const index: OrionSectionBundleIndex = {
    version: "r10-6-section-bundles-index-v1",
    caseId,
    reportRunId,
    generatedAt: new Date().toISOString(),
    sectionCount: bundles.length,
    sections: bundles.map((b) => ({
      sectionId: b.sectionId,
      order: b.order,
      title: b.title,
      analysisMode: b.analysisMode,
      applicable: b.applicable,
      allowedCount: b.allowedEvidence.length,
      dataSufficiency: b.dataSufficiency,
    })),
  };
  writeJson(join(bundlesDir, "index.json"), index);
  for (const bundle of bundles) {
    writeJson(join(bundlesDir, `${bundle.sectionId}.input.json`), bundle);
  }
}

function writeSectionAnalysisArtifacts(
  outputRoot: string,
  analyses: Awaited<ReturnType<typeof analyzeOrionSections>>["analyses"],
  meta: Awaited<ReturnType<typeof analyzeOrionSections>>["meta"],
  caseId: string,
  reportRunId: string
): void {
  const analysesDir = join(outputRoot, "section-analyses");
  mkdirSync(analysesDir, { recursive: true });
  const index: OrionSectionAnalysisIndex = {
    version: "r10-6-section-analyses-index-v1",
    caseId,
    reportRunId,
    generatedAt: new Date().toISOString(),
    gptSectionCallCount: meta.gptSectionCallCount,
    skippedSections: meta.skippedSections,
    analyses: analyses.map((a) => ({
      sectionId: a.sectionId,
      order: a.order,
      status: a.status,
      gptCallMade: a.gptCallMade ?? false,
    })),
  };
  writeJson(join(analysesDir, "index.json"), index);
  for (const analysis of analyses) {
    writeJson(join(analysesDir, `${analysis.sectionId}.analysis.json`), analysis);
  }
}

export const R10_OUTPUT_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r10-orion-golden-parallel"
);

export interface RunR10OrionGoldenResult {
  outputRoot: string;
  caseId: string;
  reportRunId: string;
  pageCount: number;
  slideCount: number;
  verdict: OrionGoldenQaVerdict;
  pdfExportMode: string;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function deriveVerdict(input: {
  gptBlocked: boolean;
  routingIssues: string[];
  relevanceOk: boolean;
  visualOk: boolean;
  clientPolicyOk: boolean;
  structureOk: boolean;
}): OrionGoldenQaVerdict {
  if (input.gptBlocked) return "BLOCKED_GPT";
  if (input.routingIssues.length > 0) return "BLOCKED_DATA_ROUTING";
  if (!input.relevanceOk) return "BLOCKED_RELEVANCE_FILTER";
  if (!input.visualOk) return "BLOCKED_VISUAL";
  if (!input.clientPolicyOk) return "BLOCKED_CLIENT_TEXT";
  if (!input.structureOk) return "BLOCKED_STRUCTURE";
  return "PASS";
}

export async function runR10OrionGoldenE2e(options: {
  caseId: string;
  outputRoot?: string;
  requireAi?: boolean;
}): Promise<RunR10OrionGoldenResult> {
  const outputRoot = options.outputRoot ?? R10_OUTPUT_ROOT;
  mkdirSync(outputRoot, { recursive: true });

  const caseId = options.caseId.trim();
  if (!caseId) throw new Error("CASE_ID required");

  const reportRunId = `orion-r10-${Date.now()}`;
  const requireAi = options.requireAi ?? true;
  const readiness = describeOrionV2AiReadiness();

  writeJson(join(outputRoot, "architecture-inspection.json"), ORION_GOLDEN_ARCHITECTURE);
  writeJson(join(outputRoot, "orion-blueprint.json"), ORION_GOLDEN_BLUEPRINT);
  writeJson(join(outputRoot, "supabase-schema-plan.json"), buildOrionGoldenSupabaseSchemaPlan());

  let ctx: Awaited<ReturnType<typeof loadRealCaseContext>>;
  try {
    ctx = await loadRealCaseContext(caseId, { locale: "ru", buildFreshReportJson: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : "db-unavailable";
    writeJson(join(outputRoot, "qa-summary.json"), {
      version: "r10-qa-summary-v1",
      caseId,
      reportRunId,
      verdict: "BLOCKED",
      blockedReason: "database-unavailable",
      detail: reason.slice(0, 300),
      architecture: ORION_GOLDEN_ARCHITECTURE.version,
      featureFlag: digitalProfileConfig.orionGoldenEnabled,
    });
    return {
      outputRoot,
      caseId,
      reportRunId,
      pageCount: 0,
      slideCount: 0,
      verdict: "BLOCKED",
      pdfExportMode: "unknown",
    };
  }

  const inventory = buildFullEvidenceInventory({ caseId, reportRunId, ctx });
  writeJson(join(outputRoot, "full-evidence-inventory.json"), inventory);

  const relevance = classifyInventoryRelevance(inventory.items, inventory.subject.fullName, inventory.subject.aliases);
  writeJson(join(outputRoot, "relevance-filter-inspection.json"), relevance);

  const judgments = buildAllEvidenceJudgments({
    items: inventory.items,
    decisions: relevance.decisions,
    subjectName: inventory.subject.fullName,
    aliases: inventory.subject.aliases,
  });
  const judgmentById = new Map(judgments.map((j) => [j.evidenceId, j]));
  writeJson(join(outputRoot, "evidence-judgment-inspection.json"), {
    version: "r10-4-evidence-judgment-inspection-v1",
    caseId,
    reportRunId,
    totalJudgments: judgments.length,
    reviewDecisionCounts: countByReviewDecision(judgments),
    riskSignalCounts: countByRiskSignal(judgments),
    judgments,
  });

  const gatedDecisions = applyJudgmentToDecisions(relevance.decisions, judgmentById);
  const gatedRelevance = { ...relevance, decisions: gatedDecisions };
  writeJson(join(outputRoot, "evidence-judgment-gated-relevance.json"), {
    version: "r10-4-gated-relevance-v1",
    caseId,
    reportRunId,
    decisions: gatedDecisions,
  });

  const routing = routeEvidenceToSections({ inventory, relevance: gatedRelevance });
  const gatedPacks = filterPacksForGpt(routing.packs, judgmentById);
  writeJson(join(outputRoot, "evidence-routing-inspection.json"), { ...routing, packs: gatedPacks });

  const bundles = buildGatedEvidenceBundles({ caseId, reportRunId, judgments });
  writeJson(join(outputRoot, "r10-4-evidence-bundles.json"), bundles);

  const snippetById = new Map(inventory.items.map((i) => [i.inventoryId, i.snippet ?? ""]));
  const manualQueue = buildManualReviewQueue({ caseId, reportRunId, judgments, snippetById });
  writeJson(join(outputRoot, "manual-review-queue.json"), manualQueue);

  const clientContentPreReview = buildOrionClientContent({
    mode: "pre_review",
    caseId,
    reportRunId,
    subject: { fullName: inventory.subject.fullName, aliases: inventory.subject.aliases },
    bundles,
    manualQueue,
    judgments,
  });

  const wrongSubjectJudgments = judgments.filter((j) => j.subjectBinding === "WRONG_SUBJECT");
  const productionAdminDecisions = ensureAdminReviewDecisions({
    caseId,
    manualQueue,
    wrongSubjectJudgments,
  });
  writeJson(join(outputRoot, "admin-review-decisions.json"), productionAdminDecisions);

  const sampleAdminDecisions = buildAdminReviewSampleFixture({
    caseId,
    manualQueue,
    judgments,
  });
  saveAdminReviewSampleFixture(sampleAdminDecisions);

  const clientContentPostReview = buildOrionClientContent({
    mode: "post_review",
    caseId,
    reportRunId,
    subject: { fullName: inventory.subject.fullName, aliases: inventory.subject.aliases },
    bundles,
    manualQueue,
    judgments,
    adminDecisions: sampleAdminDecisions.decisions,
  });

  const adminWorkflowQa = inspectAdminReviewWorkflowQa({
    preReviewContent: clientContentPreReview,
    postReviewContent: clientContentPostReview,
    productionDecisions: productionAdminDecisions,
    sampleDecisions: sampleAdminDecisions,
    judgments,
  });
  writeJson(join(outputRoot, "r10-5-admin-review-workflow-qa.json"), adminWorkflowQa);

  const regionCounts = countInventoryRegions(inventory);
  const sectionBundlesPre = buildOrionSectionBundles({
    caseInfo: { caseId, reportRunId, subjectName: inventory.subject.fullName, aliases: inventory.subject.aliases },
    inventory,
    judgments,
    manualQueue,
    adminDecisions: productionAdminDecisions.decisions,
    regionSettings: { ruEnabled: regionCounts.ru > 0, uaeEnabled: regionCounts.uae > 0 },
  });
  writeSectionBundleArtifacts(outputRoot, sectionBundlesPre, caseId, reportRunId);
  writeJson(join(outputRoot, "orion-section-registry.json"), {
    version: "r10-6-orion-section-registry-v1",
    mode: "client_audit",
    sectionCount: getClientAuditSections().length,
    sections: getClientAuditSections(),
  });

  const judgmentQa = inspectEvidenceJudgmentQa({
    judgments,
    bundles,
    clientContent: clientContentPreReview,
  });
  writeJson(join(outputRoot, "r10-4-evidence-judgment-review.json"), judgmentQa);

  const contentQuality = inspectContentQualityReview({
    clientContent: clientContentPreReview,
    judgmentVerdict: judgmentQa.verdict,
    manualReviewPendingCount: manualQueue.pendingCount,
  });
  writeJson(join(outputRoot, "r10-4-content-quality-review.json"), contentQuality);

  const routingIssues = validateRoutingAgainstBlueprint(routing);
  const relevanceOk = relevance.inputCount === inventory.items.length && relevance.excludedNoise >= 0;

  let gptBlocked = false;
  let sectionAnalyses: Awaited<ReturnType<typeof runOrionGoldenSectionAnalyses>> = [];
  let executive: Awaited<ReturnType<typeof runOrionGoldenExecutiveSynthesis>> | null = null;
  let r10SectionAnalyses: Awaited<ReturnType<typeof analyzeOrionSections>>["analyses"] = [];
  let orchestrationMeta: Awaited<ReturnType<typeof analyzeOrionSections>>["meta"] | null = null;
  let executiveSynthesisOutput: Awaited<ReturnType<typeof buildExecutiveSynthesisFromSections>> | null = null;
  let executiveSynthesisInput: ReturnType<typeof buildExecutiveSynthesisInput> | null = null;
  let sectionDerivedRiskMatrix: ReturnType<typeof buildRiskMatrixFromSections> | null = null;
  let clientContentPreReviewFromSections: ReturnType<typeof assembleOrionClientContentFromSections> | null = null;
  let clientContentPostReviewFromSections: ReturnType<typeof assembleOrionClientContentFromSections> | null = null;

  if (!readiness.ready && requireAi) {
    gptBlocked = true;
    writeJson(join(outputRoot, "gpt-section-analyses.json"), { blocked: true, reason: "gpt55-required-but-unavailable" });
    writeJson(join(outputRoot, "executive-synthesis.json"), { blocked: true });
  } else {
    try {
      const sectionResult = await analyzeOrionSections({
        sectionBundles: sectionBundlesPre,
        caseInfo: { subjectName: inventory.subject.fullName, caseId },
        requireAi,
      });
      r10SectionAnalyses = sectionResult.analyses;
      orchestrationMeta = sectionResult.meta;
      orchestrationMeta.executiveSynthesisCallCount = 1;
      orchestrationMeta.riskMatrixSynthesisCount = 1;
      writeSectionAnalysisArtifacts(outputRoot, r10SectionAnalyses, orchestrationMeta, caseId, reportRunId);
      writeJson(join(outputRoot, "r10-6-gpt-runtime-diagnostics.json"), sectionResult.runtimeDiagnostics);

      executiveSynthesisInput = buildExecutiveSynthesisInput(caseId, inventory.subject.fullName, r10SectionAnalyses);
      writeJson(join(outputRoot, "executive-synthesis.input.json"), executiveSynthesisInput);

      try {
        executiveSynthesisOutput = await buildExecutiveSynthesisFromSections({
          synthesisInput: executiveSynthesisInput,
          requireAi,
        });
      } catch {
        executiveSynthesisOutput = buildDeterministicExecutiveFallback(executiveSynthesisInput);
      }
      writeJson(join(outputRoot, "executive-synthesis.output.json"), executiveSynthesisOutput);

      sectionDerivedRiskMatrix = buildRiskMatrixFromSections({
        caseId,
        sectionAnalyses: r10SectionAnalyses,
        sectionBundles: sectionBundlesPre,
      });
      writeJson(join(outputRoot, "risk-matrix.section-derived.json"), sectionDerivedRiskMatrix);

      clientContentPreReviewFromSections = assembleOrionClientContentFromSections({
        mode: "pre_review",
        caseId,
        reportRunId,
        subject: { fullName: inventory.subject.fullName, aliases: inventory.subject.aliases },
        sectionAnalyses: r10SectionAnalyses,
        executiveSynthesis: executiveSynthesisOutput,
        riskMatrix: sectionDerivedRiskMatrix,
        manualQueue,
        adminDecisionSummary: countAdminDecisionsByStatus(productionAdminDecisions.decisions),
      });
      writeJson(join(outputRoot, "orion-client-content.pre-review.json"), clientContentPreReviewFromSections);
      writeFileSync(
        join(outputRoot, "orion-client-content.pre-review.md"),
        renderOrionClientContentMarkdown(clientContentPreReviewFromSections),
        "utf-8"
      );

      const sectionBundlesPost = buildOrionSectionBundles({
        caseInfo: { caseId, reportRunId, subjectName: inventory.subject.fullName, aliases: inventory.subject.aliases },
        inventory,
        judgments,
        manualQueue,
        adminDecisions: sampleAdminDecisions.decisions,
        regionSettings: { ruEnabled: regionCounts.ru > 0, uaeEnabled: regionCounts.uae > 0 },
      });
      clientContentPostReviewFromSections = assembleOrionClientContentFromSections({
        mode: "post_review",
        caseId,
        reportRunId,
        subject: { fullName: inventory.subject.fullName, aliases: inventory.subject.aliases },
        sectionAnalyses: r10SectionAnalyses,
        executiveSynthesis: executiveSynthesisOutput,
        riskMatrix: buildRiskMatrixFromSections({ caseId, sectionAnalyses: r10SectionAnalyses, sectionBundles: sectionBundlesPost }),
        manualQueue,
        adminDecisionSummary: countAdminDecisionsByStatus(sampleAdminDecisions.decisions),
      });
      writeJson(join(outputRoot, "orion-client-content.post-review.json"), clientContentPostReviewFromSections);
      writeFileSync(
        join(outputRoot, "orion-client-content.post-review.md"),
        renderOrionClientContentMarkdown(clientContentPostReviewFromSections),
        "utf-8"
      );
      writeJson(join(outputRoot, "orion-client-content.json"), clientContentPreReviewFromSections);
      writeFileSync(join(outputRoot, "orion-client-content.md"), renderOrionClientContentMarkdown(clientContentPreReviewFromSections), "utf-8");

      if (orchestrationMeta && executiveSynthesisInput && sectionDerivedRiskMatrix && clientContentPreReviewFromSections) {
        const sectionOrchestrationQa = inspectSectionGptOrchestrationQa({
          sectionBundles: sectionBundlesPre,
          sectionAnalyses: r10SectionAnalyses,
          orchestrationMeta,
          executiveInput: executiveSynthesisInput,
          riskMatrix: sectionDerivedRiskMatrix,
          clientContent: clientContentPreReviewFromSections,
        });
        writeJson(join(outputRoot, "r10-6-section-gpt-orchestration-qa.json"), sectionOrchestrationQa);

        const thresholdTuningQa = inspectThresholdTuningQa({
          judgments,
          clientContent: clientContentPreReviewFromSections,
          orchestrationMeta,
        });
        writeJson(join(outputRoot, "r10-7a-threshold-tuning-qa.json"), thresholdTuningQa);
      }

      const contentBrainOnly = process.env.R10_CONTENT_BRAIN_ONLY === "1";
      if (!contentBrainOnly) {
        sectionAnalyses = await runOrionGoldenSectionAnalyses({
          packs: gatedPacks,
          subjectName: inventory.subject.fullName,
          requireAi,
        });
        writeJson(join(outputRoot, "gpt-section-analyses.json"), sectionAnalyses);
        executive = await runOrionGoldenExecutiveSynthesis({
          sectionAnalyses,
          inventory,
          routing,
          requireAi,
        });
        writeJson(join(outputRoot, "executive-synthesis.json"), executive);
      } else {
        writeJson(join(outputRoot, "gpt-section-analyses.json"), {
          deprecated: true,
          note: "Use section-analyses/ for R10.6",
          r10SectionCount: r10SectionAnalyses.length,
        });
        writeJson(join(outputRoot, "executive-synthesis.json"), executiveSynthesisOutput);
      }
    } catch (err) {
      gptBlocked = true;
      const reason = err instanceof OpenAiRateLimitError ? "openai-429" : err instanceof Error ? err.message : "gpt-failed";
      writeJson(join(outputRoot, "gpt-section-analyses.json"), { blocked: true, reason });
      writeJson(join(outputRoot, "executive-synthesis.json"), { blocked: true, reason });
    }
  }

  if (gptBlocked) {
    const verdict = deriveVerdict({
      gptBlocked: true,
      routingIssues,
      relevanceOk,
      visualOk: false,
      clientPolicyOk: false,
      structureOk: false,
    });
    writeJson(join(outputRoot, "qa-summary.json"), {
      version: "r10-qa-summary-v1",
      caseId,
      reportRunId,
      verdict,
      architecture: ORION_GOLDEN_ARCHITECTURE.version,
      featureFlag: digitalProfileConfig.orionGoldenEnabled,
    });
    return { outputRoot, caseId, reportRunId, pageCount: 0, slideCount: 0, verdict, pdfExportMode: "unknown" };
  }

  if (!executive && process.env.R10_CONTENT_BRAIN_ONLY !== "1") throw new Error("executive-synthesis-missing");

  const contentBrainOnly = process.env.R10_CONTENT_BRAIN_ONLY === "1";
  const postGptJudgmentQa = inspectEvidenceJudgmentQa({
    judgments,
    bundles,
    clientContent: clientContentPreReviewFromSections ?? clientContentPreReview,
    sectionAnalyses: sectionAnalyses.length ? sectionAnalyses : undefined,
  });
  writeJson(join(outputRoot, "r10-4-evidence-judgment-review.json"), postGptJudgmentQa);

  if (contentBrainOnly) {
    const verdict = deriveVerdict({
      gptBlocked: false,
      routingIssues,
      relevanceOk,
      visualOk: true,
      clientPolicyOk: postGptJudgmentQa.passed,
      structureOk: true,
    });
    writeJson(join(outputRoot, "qa-summary.json"), {
      version: "r10-qa-summary-v1",
      caseId,
      reportRunId,
      verdict,
      contentBrainOnly: true,
      evidenceJudgmentVerdict: postGptJudgmentQa.verdict,
      contentQualityVerdict: contentQuality.verdict,
      adminWorkflowVerdict: adminWorkflowQa.verdict,
      sectionOrchestrationVerdict: orchestrationMeta ? "see-r10-6-section-gpt-orchestration-qa.json" : undefined,
      gptSectionCallCount: orchestrationMeta?.gptSectionCallCount ?? 0,
      canonicalSectionCount: getClientAuditSections().length,
      sectionBundleCount: sectionBundlesPre.length,
      adminDecisionCounts: countAdminDecisionsByStatus(productionAdminDecisions.decisions),
      adminSampleDecisionCounts: countAdminDecisionsByStatus(sampleAdminDecisions.decisions),
      reviewDecisionCounts: countByReviewDecision(judgments),
      riskSignalCounts: countByRiskSignal(judgments),
      manualReviewPending: manualQueue.pendingCount,
      architecture: ORION_GOLDEN_ARCHITECTURE.version,
      featureFlag: digitalProfileConfig.orionGoldenEnabled,
    });
    return {
      outputRoot,
      caseId,
      reportRunId,
      pageCount: 0,
      slideCount: 0,
      verdict,
      pdfExportMode: "skipped-content-brain-only",
    };
  }

  const assets = await buildOrionGoldenAssets({ ctx });
  writeJson(join(outputRoot, "report-assets.json"), assets);

  if (!executive) throw new Error("executive-synthesis-missing-for-render");

  const reportSpec = buildOrionGoldenReportSpec({
    inventory,
    sectionAnalyses,
    executive,
    assets,
  });
  writeJson(join(outputRoot, "orion-report-spec.json"), reportSpec);

  const deckManifest = composeOrionGoldenDeck(reportSpec, assets);
  writeJson(join(outputRoot, "final-deck-manifest.json"), deckManifest);

  const renderResult = await renderOrionGoldenArtifacts({
    reportSpec,
    deckManifest,
    assets,
    pptxOut: join(outputRoot, "rendered-client.pptx"),
    pdfOut: join(outputRoot, "rendered-client.pdf"),
    pagesOut: join(outputRoot, "pages-png"),
  });

  const clientPolicy = inspectOrionGoldenClientPolicy({ reportSpec, deckManifest });
  writeJson(join(outputRoot, "client-policy-inspection.json"), clientPolicy);

  const visual = inspectOrionGoldenVisualQuality({
    outputRoot,
    deckManifest,
    inventory,
    pdfExportMode: renderResult.pdfExportMode,
  });
  writeJson(join(outputRoot, "visual-qa-inspection.json"), visual);

  const structureOk =
    deckManifest.finalSlides.some((s) => s.sectionKey === "executive_summary") &&
    deckManifest.finalSlides.some((s) => s.sectionKey === "ru_search_results") &&
    deckManifest.finalSlides.some((s) => s.sectionKey === "compliance_databases");

  const verdict = deriveVerdict({
    gptBlocked: false,
    routingIssues,
    relevanceOk,
    visualOk: visual.passed,
    clientPolicyOk: clientPolicy.passed,
    structureOk,
  });

  writeJson(join(outputRoot, "qa-summary.json"), {
    version: "r10-qa-summary-v1",
    caseId,
    reportRunId,
    verdict,
    pageCount: visual.pageCount,
    slideCount: deckManifest.slideCount,
    searchResultsAccounted: routing.searchResultsAccounted,
    searchResultsUnaccounted: routing.searchResultsUnaccounted,
    gptGeneratedBy: "gpt-5.5",
    executiveAfterSections: true,
    evidenceJudgmentVerdict: postGptJudgmentQa.verdict,
    contentQualityVerdict: contentQuality.verdict,
    adminWorkflowVerdict: adminWorkflowQa.verdict,
    adminDecisionCounts: countAdminDecisionsByStatus(productionAdminDecisions.decisions),
    adminSampleDecisionCounts: countAdminDecisionsByStatus(sampleAdminDecisions.decisions),
    reviewDecisionCounts: countByReviewDecision(judgments),
    riskSignalCounts: countByRiskSignal(judgments),
    manualReviewPending: manualQueue.pendingCount,
    architecture: ORION_GOLDEN_ARCHITECTURE.version,
    featureFlag: digitalProfileConfig.orionGoldenEnabled,
    warnings: [...inventory.warnings, ...routing.warnings, ...renderResult.warnings],
  });

  return {
    outputRoot,
    caseId,
    reportRunId,
    pageCount: visual.pageCount,
    slideCount: deckManifest.slideCount,
    verdict,
    pdfExportMode: renderResult.pdfExportMode,
  };
}
