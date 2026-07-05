import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digitalProfileConfig } from "../config";
import { loadRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";
import { buildReportAssets } from "./asset-builder";
import { scanReportSpecObject, scanReportSpecForEnglishStatus } from "./client-policy-scan";
import { analyzeOrionSectionWithGpt55 } from "./gpt-section-analyzer";
import { FORBIDDEN_CLIENT_TERMS } from "./normalized-evidence";
import { buildQaReportSpecCaseContext } from "./qa-case-context";
import { renderReportSpecArtifacts } from "./report-spec-renderer-client";
import {
  buildExecutiveEvidence,
  buildRuAuditSummaryEvidence,
  buildRuSearchEvidence,
} from "./section-evidence-adapter";
import type { OrionReportSpecV1 } from "./report-spec-schema";
import { validateOrionReportSpecV1 } from "./report-spec-schema";

export interface RunReportSpecVerticalSliceOptions {
  caseId?: string;
  outputRoot?: string;
  locale?: "ru" | "en";
  useRealCaseData?: boolean;
  requireAi?: boolean;
  allowDeterministicFallback?: boolean;
}

export interface RunReportSpecVerticalSliceResult {
  outputRoot: string;
  reportSpec: OrionReportSpecV1;
  generatedBy: "gpt-5.5" | "deterministic" | "mixed";
  renderWarning: string | null;
  policyIssues: string[];
}

export async function runOrionReportSpecVerticalSlice(
  options: RunReportSpecVerticalSliceOptions = {}
): Promise<RunReportSpecVerticalSliceResult> {
  const outputRoot =
    options.outputRoot ??
    join(process.cwd(), "storage", "digital-profile", "qa-r9-7a-orion-reportspec-vertical-slice");
  mkdirSync(outputRoot, { recursive: true });

  const locale = options.locale ?? "ru";
  const caseContext =
    options.useRealCaseData === false
      ? buildQaReportSpecCaseContext()
      : await loadRealCaseContext(options.caseId ?? "qa-r97a-reportspec-case", { locale });

  const executiveEvidence = buildExecutiveEvidence(caseContext);
  const ruAuditEvidence = buildRuAuditSummaryEvidence(caseContext);
  const ruSearchEvidence = buildRuSearchEvidence(caseContext);
  const evidenceByRef = new Map<string, (typeof executiveEvidence)[number]>();
  for (const item of [...executiveEvidence, ...ruAuditEvidence, ...ruSearchEvidence]) {
    if (!evidenceByRef.has(item.evidenceRef)) evidenceByRef.set(item.evidenceRef, item);
  }
  const allEvidence = [...evidenceByRef.values()];

  writeFileSync(join(outputRoot, "normalized-evidence.json"), JSON.stringify(allEvidence, null, 2));

  const assets = await buildReportAssets({
    subjectName: caseContext.subject.fullName,
    ruSearchEvidence,
  });
  writeFileSync(join(outputRoot, "report-assets.json"), JSON.stringify(assets, null, 2));

  const requireAi = options.requireAi ?? digitalProfileConfig.orionV2RequireAi;
  const allowDeterministicFallback =
    options.allowDeterministicFallback ?? digitalProfileConfig.orionV2AllowDeterministicFallback;

  const subject = { displayName: caseContext.subject.fullName, locale };

  const executiveAnalysis = await analyzeOrionSectionWithGpt55({
    sectionKey: "executive_summary",
    subject,
    evidence: executiveEvidence,
    assets,
    language: "ru",
    requireAi,
    allowDeterministicFallback,
  });
  writeFileSync(join(outputRoot, "executive-section-analysis.json"), JSON.stringify(executiveAnalysis, null, 2));

  const ruAuditAnalysis = await analyzeOrionSectionWithGpt55({
    sectionKey: "ru_audit_summary",
    subject,
    evidence: ruAuditEvidence,
    assets,
    language: "ru",
    requireAi,
    allowDeterministicFallback,
  });
  writeFileSync(join(outputRoot, "ru-audit-section-analysis.json"), JSON.stringify(ruAuditAnalysis, null, 2));

  const ruSearchAnalysis = await analyzeOrionSectionWithGpt55({
    sectionKey: "ru_search_results",
    subject,
    evidence: ruSearchEvidence,
    assets,
    language: "ru",
    requireAi,
    allowDeterministicFallback,
  });
  writeFileSync(join(outputRoot, "ru-search-section-analysis.json"), JSON.stringify(ruSearchAnalysis, null, 2));

  const analyses = [executiveAnalysis, ruAuditAnalysis, ruSearchAnalysis];
  const generatedModes = new Set(analyses.map((a) => a.generatedBy));
  const generatedBy: RunReportSpecVerticalSliceResult["generatedBy"] =
    generatedModes.size === 1
      ? (generatedModes.values().next().value as "gpt-5.5" | "deterministic")
      : "mixed";

  const warnings = analyses.flatMap((a) => a.warnings);
  const reportSpec: OrionReportSpecV1 = {
    version: "orion-report-spec-v1",
    subject: {
      displayName: caseContext.subject.fullName,
      locale,
      generatedAt: new Date().toISOString(),
    },
    sections: analyses.map((a) => a.section),
    assets,
    evidence: allEvidence,
    qa: {
      generatedBy: generatedBy === "mixed" ? "deterministic" : generatedBy,
      requiredAi: requireAi,
      forbiddenClientTerms: [...FORBIDDEN_CLIENT_TERMS],
      warnings,
    },
  };

  validateOrionReportSpecV1(reportSpec);
  writeFileSync(join(outputRoot, "orion-report-spec-v1.json"), JSON.stringify(reportSpec, null, 2));

  const policyIssues = scanReportSpecObject(reportSpec);
  writeFileSync(
    join(outputRoot, "client-policy-inspection.json"),
    JSON.stringify(
      {
        issues: policyIssues,
        englishStatusLabels: scanReportSpecForEnglishStatus(reportSpec),
      },
      null,
      2
    )
  );

  writeFileSync(
    join(outputRoot, "reportspec-inspection.json"),
    JSON.stringify(
      {
        caseId: caseContext.caseId,
        evidenceCount: allEvidence.length,
        assetCount: assets.length,
        readyAssets: assets.filter((a) => a.status === "ready").length,
        sectionKeys: reportSpec.sections.map((s) => s.sectionKey),
        slideCount: reportSpec.sections.reduce((n, s) => n + s.slides.length, 0),
        generatedBy,
        requireAi,
        allowDeterministicFallback,
        warnings,
      },
      null,
      2
    )
  );

  const renderWarning = await renderReportSpecArtifacts({
    reportSpecPath: join(outputRoot, "orion-report-spec-v1.json"),
    pptxOut: join(outputRoot, "rendered-target-client.pptx"),
    pdfOut: join(outputRoot, "rendered-target-client.pdf"),
    pagesOut: join(outputRoot, "target-pages-png"),
  });

  return { outputRoot, reportSpec, generatedBy, renderWarning, policyIssues };
}
