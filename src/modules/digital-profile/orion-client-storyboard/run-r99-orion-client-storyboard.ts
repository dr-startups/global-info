import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness } from "../config";
import { buildReportAssets, type ReportAssetV1 } from "../orion-report-spec/asset-builder";
import { resolveR98aCaseId } from "../orion-report-spec/legacy-report-qa-builder";
import { buildQaReportSpecCaseContext } from "../orion-report-spec/qa-case-context";
import type { OrionReportSectionKey, SectionAnalysisResult } from "../orion-report-spec/report-spec-schema";
import {
  buildExecutiveEvidence,
  buildRuAuditSummaryEvidence,
  buildRuSearchEvidence,
} from "../orion-report-spec/section-evidence-adapter";
import type { OrionRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";
import { loadRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";
import { composeClientStoryboard } from "./storyboard-composer";
import {
  analyzeStoryboardSectionWithGpt55,
  buildDeterministicStoryboardAnalysis,
  mapSectionAnalysisToStoryboard,
} from "./gpt-storyboard-analyzer";
import { writeR98aVisualFailureAudit } from "./r98a-visual-failure-audit";
import { renderClientStoryboardArtifacts } from "./storyboard-render-client";
import {
  inspectClientStoryboardTextPolicy,
  inspectMediaVisual,
  inspectSerpVisual,
  inspectStoryboardVisualExport,
  inspectVisualDensity,
} from "./storyboard-visual-inspections";
import { validateClientStoryboard } from "./schema";
import type { GptStoryboardSectionAnalysis } from "./types";

export const R99_OUTPUT_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r9-9-orion-client-storyboard"
);

const R97B_ROOT = join(process.cwd(), "storage", "digital-profile", "qa-r9-7b-orion-reportspec-visual-fidelity");
const R97B_SECTION_FILES: Record<OrionReportSectionKey, string> = {
  executive_summary: "executive-section-analysis.json",
  ru_audit_summary: "ru-audit-section-analysis.json",
  ru_search_results: "ru-search-section-analysis.json",
};

export interface RunR99Options {
  outputRoot?: string;
  requireGpt?: boolean;
  allowDeterministicFallback?: boolean;
  caseId?: string;
  /** When true: skip R97B cache, require live GPT-5.5, no silent deterministic fallback. */
  liveSignOff?: boolean;
  /** Additional assets (e.g. Lexis visual pages) merged before compose. */
  mergeAssets?: ReportAssetV1[];
  /** Skip writing R98a audit artifact (R9.10 E2E). */
  skipR98aAudit?: boolean;
}

export interface RunR99Result {
  outputRoot: string;
  caseResolution: Awaited<ReturnType<typeof resolveR98aCaseId>>;
  generatedBy: "gpt-5.5" | "deterministic" | "mixed";
  pageCount: number;
  slideCount: number;
  pdfExportMode: "libreoffice" | "fitz-fallback" | "unknown";
  realCaseQualityEligible: boolean;
  visualInspection: ReturnType<typeof inspectStoryboardVisualExport>;
  verdict: string;
}

async function loadCaseContext(caseResolution: Awaited<ReturnType<typeof resolveR98aCaseId>>): Promise<OrionRealCaseContext> {
  if (caseResolution.source === "fixture") {
    return buildQaReportSpecCaseContext() as OrionRealCaseContext;
  }
  return loadRealCaseContext(caseResolution.caseId, { locale: "ru" });
}

async function loadOrRunStoryboardAnalyses(input: {
  caseContext: OrionRealCaseContext;
  requireGpt: boolean;
  allowDeterministicFallback: boolean;
  liveSignOff: boolean;
  assets: Awaited<ReturnType<typeof buildReportAssets>>;
}): Promise<GptStoryboardSectionAnalysis[]> {
  const keys: OrionReportSectionKey[] = ["executive_summary", "ru_audit_summary", "ru_search_results"];
  const subject = { displayName: input.caseContext.subject.fullName, locale: "ru" as const };
  const evidenceBySection = {
    executive_summary: buildExecutiveEvidence(input.caseContext),
    ru_audit_summary: buildRuAuditSummaryEvidence(input.caseContext),
    ru_search_results: buildRuSearchEvidence(input.caseContext),
  };

  if (!input.liveSignOff) {
    const reuse: GptStoryboardSectionAnalysis[] = [];
    for (const key of keys) {
      const path = join(R97B_ROOT, R97B_SECTION_FILES[key]);
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, "utf-8")) as SectionAnalysisResult;
        reuse.push(mapSectionAnalysisToStoryboard(parsed, key));
      }
    }
    if (reuse.length === 3) return reuse;
  }

  const out: GptStoryboardSectionAnalysis[] = [];
  for (const sectionKey of keys) {
    if (!input.liveSignOff) {
      const cachedPath = join(R97B_ROOT, R97B_SECTION_FILES[sectionKey]);
      if (existsSync(cachedPath)) {
        const parsed = JSON.parse(readFileSync(cachedPath, "utf-8")) as SectionAnalysisResult;
        out.push(mapSectionAnalysisToStoryboard(parsed, sectionKey));
        continue;
      }
    }
    try {
      const analysis = await analyzeStoryboardSectionWithGpt55({
        sectionKey,
        subject,
        evidence: evidenceBySection[sectionKey],
        assets: input.assets,
        requireAi: input.requireGpt,
        allowDeterministicFallback: input.allowDeterministicFallback,
        maxOpenaiRetries: 6,
      });
      if (input.liveSignOff && analysis.generatedBy !== "gpt-5.5") {
        throw new Error(`live-signoff-non-gpt:${sectionKey}`);
      }
      out.push(analysis);
    } catch (error) {
      if (input.liveSignOff) {
        const { OpenAiRateLimitError, isOpenAiHttp429 } = await import("../orion-report-spec/openai-rate-limit");
        if (isOpenAiHttp429(error)) throw new OpenAiRateLimitError();
        throw error instanceof Error ? error : new Error(`gpt-storyboard-required-failed:${sectionKey}`);
      }
      out.push(
        buildDeterministicStoryboardAnalysis({
          sectionKey,
          subjectName: subject.displayName,
          evidence: evidenceBySection[sectionKey],
        })
      );
    }
  }
  return out;
}

export async function runR99OrionClientStoryboard(options: RunR99Options = {}): Promise<RunR99Result> {
  const outputRoot = options.outputRoot ?? R99_OUTPUT_ROOT;
  mkdirSync(outputRoot, { recursive: true });

  if (!options.skipR98aAudit) {
    writeR98aVisualFailureAudit(join(outputRoot, "r98a-visual-failure-audit.json"));
  }

  const readiness = describeOrionV2AiReadiness();
  const requireGpt = options.requireGpt ?? readiness.ready;
  const liveSignOff = options.liveSignOff ?? false;
  const allowDeterministicFallback = liveSignOff
    ? false
    : (options.allowDeterministicFallback ?? !requireGpt);

  let caseResolution = await resolveR98aCaseId();
  if (options.caseId) {
    caseResolution = { caseId: options.caseId, source: "env", hasRealData: true };
  }

  const caseContext = await loadCaseContext(caseResolution);
  const executiveEvidence = buildExecutiveEvidence(caseContext);
  const ruAuditEvidence = buildRuAuditSummaryEvidence(caseContext);
  const ruSearchEvidence = buildRuSearchEvidence(caseContext);
  const evidenceByRef = new Map<string, (typeof executiveEvidence)[number]>();
  for (const item of [...executiveEvidence, ...ruAuditEvidence, ...ruSearchEvidence]) {
    if (!evidenceByRef.has(item.evidenceRef)) evidenceByRef.set(item.evidenceRef, item);
  }
  const allEvidence = [...evidenceByRef.values()];
  writeFileSync(join(outputRoot, "normalized-evidence.json"), JSON.stringify(allEvidence, null, 2));

  const assets = [
    ...(await buildReportAssets({
      subjectName: caseContext.subject.fullName,
      ruSearchEvidence,
    })),
    ...(options.mergeAssets ?? []),
  ];
  writeFileSync(join(outputRoot, "report-assets.json"), JSON.stringify(assets, null, 2));

  const gptAnalyses = await loadOrRunStoryboardAnalyses({
    caseContext,
    requireGpt,
    allowDeterministicFallback,
    liveSignOff,
    assets,
  });
  writeFileSync(join(outputRoot, "gpt-section-analyses.json"), JSON.stringify(gptAnalyses, null, 2));

  const storyboard = composeClientStoryboard({
    caseContext,
    caseResolution,
    evidence: allEvidence,
    assets,
    gptAnalyses,
    requireAi: requireGpt,
  });
  validateClientStoryboard(storyboard);
  writeFileSync(join(outputRoot, "client-storyboard.json"), JSON.stringify(storyboard, null, 2));

  const render = await renderClientStoryboardArtifacts({
    storyboard,
    assets,
    pptxOut: join(outputRoot, "rendered-client.pptx"),
    pdfOut: join(outputRoot, "rendered-client.pdf"),
    pagesOut: join(outputRoot, "pages-png"),
  });

  const generatedBy = storyboard.qa.generatedBy;
  const textPolicy = inspectClientStoryboardTextPolicy(storyboard);
  const serpInspection = inspectSerpVisual({ outputRoot, storyboard, assets });
  const mediaInspection = inspectMediaVisual({ storyboard, assets });
  const densityInspection = inspectVisualDensity(storyboard, storyboard.slides.length);

  writeFileSync(join(outputRoot, "serp-visual-inspection.json"), JSON.stringify(serpInspection, null, 2));
  writeFileSync(join(outputRoot, "media-visual-inspection.json"), JSON.stringify(mediaInspection, null, 2));
  writeFileSync(
    join(outputRoot, "client-text-policy-inspection.json"),
    JSON.stringify(textPolicy, null, 2)
  );
  writeFileSync(
    join(outputRoot, "visual-density-inspection.json"),
    JSON.stringify(densityInspection, null, 2)
  );

  const visualInspection = inspectStoryboardVisualExport({
    outputRoot,
    storyboard,
    assets,
    pdfExportMode: render.pdfExportMode,
    caseSource: caseResolution.source,
  });
  writeFileSync(join(outputRoot, "visual-export-inspection.json"), JSON.stringify(visualInspection, null, 2));

  let verdict = visualInspection.passed ? "PASS" : "BLOCKED_VISUAL_QUALITY";
  if (!serpInspection.passed && storyboard.slides.some((s) => s.slideType === "serp_screenshot")) {
    verdict = "BLOCKED_SERP_VISUAL";
  }
  if (requireGpt && generatedBy !== "gpt-5.5" && caseResolution.source !== "fixture") {
    verdict = "BLOCKED";
  }
  if (!storyboard.qa.realCaseQualityEligible && requireGpt) {
    verdict = "BLOCKED_REAL_CASE_REQUIRED";
  }

  const qaSummary = {
    version: "r99-qa-summary-v1",
    caseResolution,
    generatedBy,
    requireGpt,
    renderer: "orion_visual_composer",
    pdfExportMode: render.pdfExportMode,
    realCaseQualityEligible: storyboard.qa.realCaseQualityEligible,
    pageCount: visualInspection.pageCount,
    slideCount: storyboard.slides.length,
    visualInspection,
    verdict,
    renderWarnings: render.warnings,
  };
  writeFileSync(join(outputRoot, "qa-summary.json"), JSON.stringify(qaSummary, null, 2));

  return {
    outputRoot,
    caseResolution,
    generatedBy,
    pageCount: visualInspection.pageCount,
    slideCount: storyboard.slides.length,
    pdfExportMode: render.pdfExportMode,
    realCaseQualityEligible: storyboard.qa.realCaseQualityEligible,
    visualInspection,
    verdict,
  };
}
