import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness } from "../config";
import { analyzeOrionSectionWithGpt55 } from "./gpt-section-analyzer";
import { injectGptNarrativesIntoLegacyReportVm } from "./legacy-gpt-narrative-injector";
import { buildLegacyReportJsonForR98a, resolveR98aCaseId } from "./legacy-report-qa-builder";
import { writeLegacyQaRenderArtifacts } from "./legacy-render-qa-client";
import { buildReportAssets } from "./asset-builder";
import { buildDeterministicSectionAnalysis } from "./deterministic-section-analyzer";
import {
  buildExecutiveEvidence,
  buildRuAuditSummaryEvidence,
  buildRuSearchEvidence,
} from "./section-evidence-adapter";
import type { OrionReportSectionKey, SectionAnalysisResult } from "./report-spec-schema";
import { inspectR98aVisualExport } from "./visual-export-inspection";
import { assertClientReportPolicy } from "../report/report-data-policy";
import { prepareLegacyClientRenderPayload } from "../services/report-renderer-service";
import type { OrionRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";
import { buildQaReportSpecCaseContext } from "./qa-case-context";

export const R98A_OUTPUT_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r9-8a-legacy-visual-gpt-narrative"
);

const R97B_SECTION_FILES: Record<OrionReportSectionKey, string> = {
  executive_summary: "executive-section-analysis.json",
  ru_audit_summary: "ru-audit-section-analysis.json",
  ru_search_results: "ru-search-section-analysis.json",
};

const R97B_ROOT = join(process.cwd(), "storage", "digital-profile", "qa-r9-7b-orion-reportspec-visual-fidelity");

export interface RunR98aOptions {
  outputRoot?: string;
  requireGpt?: boolean;
  allowDeterministicFallback?: boolean;
  caseId?: string;
}

export interface RunR98aResult {
  outputRoot: string;
  caseResolution: Awaited<ReturnType<typeof resolveR98aCaseId>>;
  sectionAnalyses: SectionAnalysisResult[];
  generatedBy: "gpt-5.5" | "deterministic" | "mixed";
  visualInspection: ReturnType<typeof inspectR98aVisualExport>;
  pageCount: number;
  slideCount: number;
  pdfExportMode: "libreoffice" | "unknown";
  blockedRealCaseRequired: boolean;
}

function toOrionContext(
  ctx: OrionRealCaseContext | ReturnType<typeof buildQaReportSpecCaseContext>
): OrionRealCaseContext {
  return ctx as OrionRealCaseContext;
}

async function loadOrRunSectionAnalyses(input: {
  caseContext: OrionRealCaseContext;
  requireGpt: boolean;
  allowDeterministicFallback: boolean;
}): Promise<SectionAnalysisResult[]> {
  const keys: OrionReportSectionKey[] = ["executive_summary", "ru_audit_summary", "ru_search_results"];
  const reuse: SectionAnalysisResult[] = [];
  for (const key of keys) {
    const path = join(R97B_ROOT, R97B_SECTION_FILES[key]);
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as SectionAnalysisResult;
      if (parsed.generatedBy === "gpt-5.5") {
        reuse.push(parsed);
        continue;
      }
    }
    break;
  }
  if (reuse.length === 3) return reuse;

  const executiveEvidence = buildExecutiveEvidence(input.caseContext);
  const ruAuditEvidence = buildRuAuditSummaryEvidence(input.caseContext);
  const ruSearchEvidence = buildRuSearchEvidence(input.caseContext);
  const assets = await buildReportAssets({
    subjectName: input.caseContext.subject.fullName,
    ruSearchEvidence,
  });
  const subject = { displayName: input.caseContext.subject.fullName, locale: "ru" as const };
  const sections: OrionReportSectionKey[] = ["executive_summary", "ru_audit_summary", "ru_search_results"];
  const evidenceBySection: Record<OrionReportSectionKey, typeof executiveEvidence> = {
    executive_summary: executiveEvidence,
    ru_audit_summary: ruAuditEvidence,
    ru_search_results: ruSearchEvidence,
  };
  const out: SectionAnalysisResult[] = [];
  for (const sectionKey of sections) {
    try {
      const analysis = await analyzeOrionSectionWithGpt55({
        sectionKey,
        subject,
        evidence: evidenceBySection[sectionKey],
        assets,
        language: "ru",
        requireAi: input.requireGpt,
        allowDeterministicFallback: input.allowDeterministicFallback,
        maxOpenaiRetries: 6,
      });
      out.push(analysis);
    } catch {
      if (!input.allowDeterministicFallback) throw new Error(`gpt-required-failed:${sectionKey}`);
      const fallback = buildDeterministicSectionAnalysis({
        sectionKey,
        subjectName: subject.displayName,
        evidence: evidenceBySection[sectionKey],
        assets,
      });
      out.push({ ...fallback, warnings: ["deterministic-fallback:qa"] });
    }
  }
  return out;
}

export async function runR98aLegacyVisualGpt(options: RunR98aOptions = {}): Promise<RunR98aResult> {
  const outputRoot = options.outputRoot ?? R98A_OUTPUT_ROOT;
  mkdirSync(outputRoot, { recursive: true });

  const readiness = describeOrionV2AiReadiness();
  const requireGpt = options.requireGpt ?? readiness.ready;
  const allowDeterministicFallback = options.allowDeterministicFallback ?? !requireGpt;

  let caseResolution = await resolveR98aCaseId();
  if (options.caseId) {
    caseResolution = { caseId: options.caseId, source: "env", hasRealData: true };
  }

  const { reportJson: legacyBefore, caseContext } = await buildLegacyReportJsonForR98a(caseResolution);
  writeFileSync(join(outputRoot, "legacy-report-json-before-gpt.json"), JSON.stringify(legacyBefore, null, 2));

  const sectionAnalyses = await loadOrRunSectionAnalyses({
    caseContext: toOrionContext(caseContext),
    requireGpt,
    allowDeterministicFallback,
  });
  writeFileSync(join(outputRoot, "gpt-section-analyses.json"), JSON.stringify(sectionAnalyses, null, 2));

  const injected = injectGptNarrativesIntoLegacyReportVm({
    legacyReportJson: legacyBefore,
    sectionAnalyses,
  });
  writeFileSync(join(outputRoot, "legacy-report-json-after-gpt.json"), JSON.stringify(injected.reportJson, null, 2));

  const render = await writeLegacyQaRenderArtifacts({
    caseId: caseResolution.caseId,
    reportJson: injected.reportJson,
    pptxOut: join(outputRoot, "rendered-client.pptx"),
    pdfOut: join(outputRoot, "rendered-client.pdf"),
    pagesOut: join(outputRoot, "pages-png"),
  });

  const policyIssues = assertClientReportPolicy(JSON.stringify(injected.reportJson));

  const { json: clientRenderJson } = await prepareLegacyClientRenderPayload(
    caseResolution.caseId,
    injected.reportJson
  );

  const visualInspection = inspectR98aVisualExport({
    outputRoot,
    clientReportJson: clientRenderJson,
    pdfExportMode: render.pdfExportMode,
    gptGeneratedBy: injected.generatedBy,
    requireGpt,
  });

  writeFileSync(join(outputRoot, "visual-export-inspection.json"), JSON.stringify(visualInspection, null, 2));
  writeFileSync(
    join(outputRoot, "serp-visual-inspection.json"),
    JSON.stringify(
      {
        pdfSerpHasImages: visualInspection.pdfSerpHasImages,
        serpPptxPictures: visualInspection.serpPptxPictures,
        pdfExportMode: render.pdfExportMode,
      },
      null,
      2
    )
  );
  writeFileSync(
    join(outputRoot, "image-video-knowledge-inspection.json"),
    JSON.stringify(
      {
        pdfAnyImages: visualInspection.pdfAnyImages,
        pptxHasPictures: visualInspection.pptxHasPictures,
        auditRuRegion: injected.reportJson.auditSummary?.regions.find((r) => r.region === "RU"),
      },
      null,
      2
    )
  );
  writeFileSync(
    join(outputRoot, "client-policy-inspection.json"),
    JSON.stringify({ issues: policyIssues }, null, 2)
  );

  const blockedRealCaseRequired = caseResolution.source === "fixture" && requireGpt;

  const qaSummary = {
    caseResolution,
    generatedBy: injected.generatedBy,
    requireGpt,
    legacyRenderer: "report_template_v3",
    reportSpecRendererUsed: false,
    visualInspection,
    renderWarnings: render.warnings,
    blockedRealCaseRequired,
    pageCount: render.pageCount,
    slideCount: render.slideCount,
  };
  writeFileSync(join(outputRoot, "qa-summary.json"), JSON.stringify(qaSummary, null, 2));

  return {
    outputRoot,
    caseResolution,
    sectionAnalyses,
    generatedBy: injected.generatedBy,
    visualInspection,
    pageCount: render.pageCount,
    slideCount: render.slideCount,
    pdfExportMode: render.pdfExportMode,
    blockedRealCaseRequired,
  };
}
