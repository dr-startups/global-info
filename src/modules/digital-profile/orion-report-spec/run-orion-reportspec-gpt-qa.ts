import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness } from "../config";
import { buildReportAssets } from "./asset-builder";
import { scanReportSpecObject, scanReportSpecForEnglishStatus } from "./client-policy-scan";
import { analyzeOrionSectionWithGpt55 } from "./gpt-section-analyzer";
import { FORBIDDEN_CLIENT_TERMS } from "./normalized-evidence";
import { OpenAiRateLimitError } from "./openai-rate-limit";
import { buildQaReportSpecCaseContext } from "./qa-case-context";
import { renderReportSpecArtifacts } from "./report-spec-renderer-client";
import type { OrionReportSpecV1, OrionReportSectionKey, SectionAnalysisResult } from "./report-spec-schema";
import { validateOrionReportSpecV1 } from "./report-spec-schema";
import { R97B_OUTPUT_ROOT } from "./run-orion-reportspec-visual-fidelity";
import {
  buildExecutiveEvidence,
  buildRuAuditSummaryEvidence,
  buildRuSearchEvidence,
} from "./section-evidence-adapter";
import { inspectSyntheticSerp, inspectReportSpecVisualQuality } from "./visual-quality-inspection";

export const TARGET_SECTIONS: OrionReportSectionKey[] = [
  "executive_summary",
  "ru_audit_summary",
  "ru_search_results",
];

export const SECTION_ANALYSIS_FILES: Record<OrionReportSectionKey, string> = {
  executive_summary: "executive-section-analysis.json",
  ru_audit_summary: "ru-audit-section-analysis.json",
  ru_search_results: "ru-search-section-analysis.json",
};

export interface ReportSpecGptQaOptions {
  outputRoot?: string;
  /** Run GPT for this section only; skips compose/render unless all sections already GPT. */
  section?: OrionReportSectionKey;
  /** Reuse successful GPT section JSON files; only call GPT for missing/non-gpt sections. */
  resume?: boolean;
  /** Delay between section GPT calls in resume/multi mode (default 120000 ms). */
  delayMs?: number;
  maxOpenaiRetries?: number;
  /** Force compose + render even when not all sections are GPT (default false). */
  forceCompose?: boolean;
}

export interface ReportSpecGptQaResult {
  outputRoot: string;
  sectionsRun: OrionReportSectionKey[];
  sectionsSkipped: OrionReportSectionKey[];
  sectionStatus: Record<OrionReportSectionKey, "gpt-5.5" | "deterministic" | "missing">;
  composed: boolean;
  rendered: boolean;
  liveGptReady: boolean;
  allSectionsGpt: boolean;
  blockedForLiveGpt: boolean;
  reportSpec?: OrionReportSpecV1;
  visualInspection?: ReturnType<typeof inspectReportSpecVisualQuality>;
  pageCount: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function evidenceForSection(
  sectionKey: OrionReportSectionKey,
  ctx: ReturnType<typeof buildPreparedContext>
): ReturnType<typeof buildExecutiveEvidence> {
  switch (sectionKey) {
    case "executive_summary":
      return ctx.executiveEvidence;
    case "ru_audit_summary":
      return ctx.ruAuditEvidence;
    default:
      return ctx.ruSearchEvidence;
  }
}

function buildPreparedContext() {
  const caseContext = buildQaReportSpecCaseContext();
  const executiveEvidence = buildExecutiveEvidence(caseContext);
  const ruAuditEvidence = buildRuAuditSummaryEvidence(caseContext);
  const ruSearchEvidence = buildRuSearchEvidence(caseContext);
  const evidenceByRef = new Map<string, (typeof executiveEvidence)[number]>();
  for (const item of [...executiveEvidence, ...ruAuditEvidence, ...ruSearchEvidence]) {
    if (!evidenceByRef.has(item.evidenceRef)) evidenceByRef.set(item.evidenceRef, item);
  }
  return {
    caseContext,
    executiveEvidence,
    ruAuditEvidence,
    ruSearchEvidence,
    allEvidence: [...evidenceByRef.values()],
    subject: { displayName: caseContext.subject.fullName, locale: "ru" as const },
  };
}

async function ensureBaseArtifacts(outputRoot: string) {
  mkdirSync(outputRoot, { recursive: true });
  const ctx = buildPreparedContext();
  const assets = await buildReportAssets({
    subjectName: ctx.caseContext.subject.fullName,
    ruSearchEvidence: ctx.ruSearchEvidence,
  });
  writeFileSync(join(outputRoot, "normalized-evidence.json"), JSON.stringify(ctx.allEvidence, null, 2));
  writeFileSync(join(outputRoot, "report-assets.json"), JSON.stringify(assets, null, 2));
  return { ...ctx, assets };
}

function loadSectionAnalysis(outputRoot: string, sectionKey: OrionReportSectionKey): SectionAnalysisResult | null {
  const path = join(outputRoot, SECTION_ANALYSIS_FILES[sectionKey]);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SectionAnalysisResult;
  } catch {
    return null;
  }
}

function isGptAnalysis(analysis: SectionAnalysisResult | null): boolean {
  return Boolean(analysis && analysis.generatedBy === "gpt-5.5");
}

async function runGptForSection(input: {
  sectionKey: OrionReportSectionKey;
  prepared: Awaited<ReturnType<typeof ensureBaseArtifacts>>;
  maxOpenaiRetries: number;
}): Promise<SectionAnalysisResult> {
  return analyzeOrionSectionWithGpt55({
    sectionKey: input.sectionKey,
    subject: input.prepared.subject,
    evidence: evidenceForSection(input.sectionKey, input.prepared),
    assets: input.prepared.assets,
    language: "ru",
    requireAi: true,
    allowDeterministicFallback: false,
    maxOpenaiRetries: input.maxOpenaiRetries,
  });
}

function composeReportSpec(
  prepared: Awaited<ReturnType<typeof ensureBaseArtifacts>>,
  analyses: SectionAnalysisResult[],
  requireAi: boolean
): OrionReportSpecV1 {
  const generatedModes = new Set(analyses.map((a) => a.generatedBy));
  const generatedBy =
    generatedModes.size === 1
      ? (generatedModes.values().next().value as "gpt-5.5" | "deterministic")
      : "deterministic";
  const warnings = analyses.flatMap((a) => a.warnings);
  const reportSpec: OrionReportSpecV1 = {
    version: "orion-report-spec-v1",
    subject: {
      displayName: prepared.subject.displayName,
      locale: prepared.subject.locale,
      generatedAt: new Date().toISOString(),
    },
    sections: analyses.map((a) => a.section),
    assets: prepared.assets,
    evidence: prepared.allEvidence,
    qa: {
      generatedBy: generatedModes.has("gpt-5.5") && !generatedModes.has("deterministic") ? "gpt-5.5" : generatedBy,
      requiredAi: requireAi,
      forbiddenClientTerms: [...FORBIDDEN_CLIENT_TERMS],
      warnings,
    },
  };
  validateOrionReportSpecV1(reportSpec);
  return reportSpec;
}

async function composeAndRenderIfReady(input: {
  outputRoot: string;
  prepared: Awaited<ReturnType<typeof ensureBaseArtifacts>>;
  analysesBySection: Map<OrionReportSectionKey, SectionAnalysisResult>;
  requireAi: boolean;
}): Promise<{ composed: boolean; rendered: boolean; reportSpec?: OrionReportSpecV1 }> {
  const allGpt = TARGET_SECTIONS.every((key) => isGptAnalysis(input.analysesBySection.get(key) ?? null));
  if (!allGpt) {
    return { composed: false, rendered: false };
  }
  const analyses = TARGET_SECTIONS.map((key) => input.analysesBySection.get(key)!);
  const reportSpec = composeReportSpec(input.prepared, analyses, input.requireAi);
  writeFileSync(join(input.outputRoot, "orion-report-spec-v1.json"), JSON.stringify(reportSpec, null, 2));

  const policyIssues = scanReportSpecObject(reportSpec);
  writeFileSync(
    join(input.outputRoot, "client-policy-inspection.json"),
    JSON.stringify(
      { issues: policyIssues, englishStatusLabels: scanReportSpecForEnglishStatus(reportSpec) },
      null,
      2
    )
  );
  writeFileSync(
    join(input.outputRoot, "reportspec-inspection.json"),
    JSON.stringify(
      {
        caseId: input.prepared.caseContext.caseId,
        evidenceCount: input.prepared.allEvidence.length,
        assetCount: input.prepared.assets.length,
        readyAssets: input.prepared.assets.filter((a) => a.status === "ready").length,
        sectionKeys: reportSpec.sections.map((s) => s.sectionKey),
        slideCount: reportSpec.sections.reduce((n, s) => n + s.slides.length, 0),
        generatedBy: "gpt-5.5",
        requireAi: input.requireAi,
        allowDeterministicFallback: false,
        warnings: analyses.flatMap((a) => a.warnings),
        mode: "gpt-qa-resume",
      },
      null,
      2
    )
  );

  await renderReportSpecArtifacts({
    reportSpecPath: join(input.outputRoot, "orion-report-spec-v1.json"),
    pptxOut: join(input.outputRoot, "rendered-target-client.pptx"),
    pdfOut: join(input.outputRoot, "rendered-target-client.pdf"),
    pagesOut: join(input.outputRoot, "target-pages-png"),
  });

  return { composed: true, rendered: true, reportSpec };
}

function writeGptInspection(outputRoot: string, input: {
  liveGptReady: boolean;
  sectionStatus: Record<OrionReportSectionKey, "gpt-5.5" | "deterministic" | "missing">;
  sectionsRun: OrionReportSectionKey[];
  mode: string;
}) {
  const readiness = describeOrionV2AiReadiness();
  const allGpt = TARGET_SECTIONS.every((k) => input.sectionStatus[k] === "gpt-5.5");
  writeFileSync(
    join(outputRoot, "gpt-section-analysis-inspection.json"),
    JSON.stringify(
      {
        liveGptReady: input.liveGptReady,
        liveGptUsed: allGpt,
        blockedForLiveGpt: !allGpt,
        generatedBy: allGpt ? "gpt-5.5" : "partial",
        requireAi: true,
        model: readiness.model,
        aiEnabled: readiness.aiEnabled,
        hasOpenAiKey: readiness.hasOpenAiKey,
        mode: input.mode,
        sectionsRun: input.sectionsRun,
        sectionStatus: input.sectionStatus,
      },
      null,
      2
    )
  );
}

/** QA-only incremental GPT runner for R9.7b live sign-off. */
export async function runOrionReportSpecGptQa(
  options: ReportSpecGptQaOptions = {}
): Promise<ReportSpecGptQaResult> {
  const outputRoot = options.outputRoot ?? R97B_OUTPUT_ROOT;
  const delayMs = options.delayMs ?? 120_000;
  const maxOpenaiRetries = options.maxOpenaiRetries ?? 6;
  const readiness = describeOrionV2AiReadiness();
  const liveGptReady = readiness.ready;

  if (!liveGptReady) {
    throw new Error("gpt55-required-but-unavailable");
  }

  const prepared = await ensureBaseArtifacts(outputRoot);
  const analysesBySection = new Map<OrionReportSectionKey, SectionAnalysisResult>();
  const sectionStatus: Record<OrionReportSectionKey, "gpt-5.5" | "deterministic" | "missing"> = {
    executive_summary: "missing",
    ru_audit_summary: "missing",
    ru_search_results: "missing",
  };

  for (const key of TARGET_SECTIONS) {
    const existing = loadSectionAnalysis(outputRoot, key);
    if (existing?.generatedBy === "gpt-5.5") {
      analysesBySection.set(key, existing);
      sectionStatus[key] = "gpt-5.5";
    } else if (existing) {
      sectionStatus[key] = existing.generatedBy === "deterministic" ? "deterministic" : "missing";
    }
  }

  let sectionsToRun: OrionReportSectionKey[];
  if (options.section) {
    sectionsToRun = [options.section];
  } else if (options.resume) {
    sectionsToRun = TARGET_SECTIONS.filter((key) => !isGptAnalysis(analysesBySection.get(key) ?? null));
  } else {
    sectionsToRun = [...TARGET_SECTIONS];
  }

  const sectionsRun: OrionReportSectionKey[] = [];
  const sectionsSkipped = TARGET_SECTIONS.filter((key) => !sectionsToRun.includes(key) && isGptAnalysis(analysesBySection.get(key) ?? null));

  for (let i = 0; i < sectionsToRun.length; i += 1) {
    const sectionKey = sectionsToRun[i]!;
    if (options.resume && isGptAnalysis(analysesBySection.get(sectionKey) ?? null)) {
      continue;
    }
    if (i > 0 && delayMs > 0) {
      await sleep(delayMs);
    }
    const analysis = await runGptForSection({ sectionKey, prepared, maxOpenaiRetries });
    writeFileSync(join(outputRoot, SECTION_ANALYSIS_FILES[sectionKey]), JSON.stringify(analysis, null, 2));
    analysesBySection.set(sectionKey, analysis);
    sectionStatus[sectionKey] = analysis.generatedBy === "gpt-5.5" ? "gpt-5.5" : "deterministic";
    sectionsRun.push(sectionKey);
  }

  writeGptInspection(outputRoot, {
    liveGptReady,
    sectionStatus,
    sectionsRun,
    mode: options.section ? "single-section" : options.resume ? "resume" : "full",
  });

  writeFileSync(
    join(outputRoot, "synthetic-serp-inspection.json"),
    JSON.stringify(
      inspectSyntheticSerp({
        assets: prepared.assets,
        evidenceCount: prepared.ruSearchEvidence.filter((e) => e.sourceKind === "search_result").length,
      }),
      null,
      2
    )
  );

  const allSectionsGpt = TARGET_SECTIONS.every((key) => sectionStatus[key] === "gpt-5.5");
  let composed = false;
  let rendered = false;
  let reportSpec: OrionReportSpecV1 | undefined;

  if (allSectionsGpt || options.forceCompose) {
    if (allSectionsGpt) {
      const result = await composeAndRenderIfReady({
        outputRoot,
        prepared,
        analysesBySection,
        requireAi: true,
      });
      composed = result.composed;
      rendered = result.rendered;
      reportSpec = result.reportSpec;
    }
  }

  const pagesDir = join(outputRoot, "target-pages-png");
  const pageCount = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => f.startsWith("page-") && f.endsWith(".png")).length
    : 0;

  let visualInspection: ReturnType<typeof inspectReportSpecVisualQuality> | undefined;
  if (reportSpec) {
    visualInspection = inspectReportSpecVisualQuality({
      reportSpec,
      pageCount,
      gptUsed: true,
      gptRequired: true,
    });
    writeFileSync(
      join(outputRoot, "reportspec-visual-quality-inspection.json"),
      JSON.stringify(visualInspection, null, 2)
    );
  }

  return {
    outputRoot,
    sectionsRun,
    sectionsSkipped,
    sectionStatus,
    composed,
    rendered,
    liveGptReady,
    allSectionsGpt,
    blockedForLiveGpt: !allSectionsGpt,
    reportSpec,
    visualInspection,
    pageCount,
  };
}

export { OpenAiRateLimitError };
