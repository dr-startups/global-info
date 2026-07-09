/**
 * R10.9 — Renderer integration smoke QA (not final visual polish).
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { OrionGoldenDeckManifest } from "../composer/orion-deck-composer";
import type { OrionGoldenReportSpec } from "../report-spec/orion-report-spec";
import { inspectClientRenderContent } from "./r10-9-client-render-content-inspection";

export type RendererIntegrationVerdict =
  | "RENDERER_INTEGRATION_READY"
  | "RENDERER_INTEGRATION_READY_WITH_VISUAL_ISSUES"
  | "BLOCKED_REPORTSPEC_ADAPTER"
  | "BLOCKED_RENDER_FROM_OLD_CONTENT"
  | "BLOCKED_CLIENT_TEXT_LEAK"
  | "BLOCKED_WRONG_SUBJECT_RENDERED"
  | "BLOCKED_PENDING_AS_CONFIRMED"
  | "BLOCKED_RENDERER_EXPORT";

function check(id: string, passed: boolean, detail: string) {
  return { id, passed, detail };
}

export function inspectRendererIntegrationQa(input: {
  outputRoot: string;
  reportSpec?: OrionGoldenReportSpec;
  deckManifest?: OrionGoldenDeckManifest;
}): {
  version: "r10-9-renderer-integration-qa-v1";
  passed: boolean;
  verdict: RendererIntegrationVerdict;
  issues: string[];
  pageCount: number;
  pngCount: number;
  pdfBytes: number;
  pptxBytes: number;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  contentInspection?: ReturnType<typeof inspectClientRenderContent>;
} {
  const root = input.outputRoot;
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const pdfPath = join(root, "rendered-client.pdf");
  const pptxPath = join(root, "rendered-client.pptx");
  const pagesDir = join(root, "pages-png");
  const specFromClient = join(root, "orion-report-spec.from-client-content.json");
  const specPath = existsSync(specFromClient) ? specFromClient : join(root, "orion-report-spec.json");
  const deckPath = join(root, "final-deck-manifest.json");
  const postReview = join(root, "orion-client-content.post-review.json");

  const pdfOk = existsSync(pdfPath) && statSync(pdfPath).size > 1000;
  const pptxOk = existsSync(pptxPath) && statSync(pptxPath).size > 1000;
  const pdfBytes = pdfOk ? statSync(pdfPath).size : 0;
  const pptxBytes = pptxOk ? statSync(pptxPath).size : 0;
  checks.push(check("pdf-exists", pdfOk, pdfPath));
  checks.push(check("pptx-exists", pptxOk, pptxPath));
  if (!pdfOk || !pptxOk) issues.push("export");

  let pngCount = 0;
  if (existsSync(pagesDir)) {
    pngCount = readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length;
  }
  checks.push(check("page-pngs", pngCount > 0, `count=${pngCount}`));
  if (pngCount === 0) issues.push("export");

  const adapterOk = existsSync(specFromClient);
  checks.push(check("reportspec-from-client-content", adapterOk, specFromClient));
  if (!adapterOk) issues.push("adapter");

  checks.push(check("post-review-content", existsSync(postReview), postReview));

  let reportSpec =
    input.reportSpec ??
    (existsSync(specPath)
      ? (JSON.parse(readFileSync(specPath, "utf-8")) as OrionGoldenReportSpec)
      : null);
  let deckManifest =
    input.deckManifest ??
    (existsSync(deckPath)
      ? (JSON.parse(readFileSync(deckPath, "utf-8")) as OrionGoldenDeckManifest)
      : null);

  let contentInspection: ReturnType<typeof inspectClientRenderContent> | undefined;
  if (reportSpec && deckManifest) {
    contentInspection = inspectClientRenderContent({
      reportSpec,
      deckManifest,
      clientContentPath: postReview,
    });
    checks.push(
      check("content-inspection", contentInspection.passed, contentInspection.verdict)
    );
    if (!contentInspection.passed) {
      if (contentInspection.verdict === "BLOCKED_CLIENT_TEXT_LEAK") issues.push("text-leak");
      else if (contentInspection.verdict === "BLOCKED_WRONG_SUBJECT_RENDERED") issues.push("wrong-subject");
      else if (contentInspection.verdict === "BLOCKED_PENDING_AS_CONFIRMED") issues.push("pending");
      else issues.push("content");
    }

    const fromOld =
      !reportSpec.qaMetadata.architectureVersion.includes("r10-9") &&
      !reportSpec.qaMetadata.warnings.some((w) => w.includes("client_audit_render"));
    checks.push(check("not-old-pipeline", !fromOld, reportSpec.qaMetadata.architectureVersion));
    if (fromOld) issues.push("old-content");

    const commercial = deckManifest.finalSlides.some((s) =>
      ["product_overview", "about", "solution_digital_profile"].includes(s.sectionKey)
    );
    checks.push(check("no-marketing-slides", !commercial, `commercial=${commercial}`));

    const hasExec = deckManifest.finalSlides.some((s) => s.sectionKey === "executive_summary");
    const hasRisk = deckManifest.finalSlides.some((s) => s.sectionKey === "compliance_risk_matrix");
    const hasManual = deckManifest.finalSlides.some(
      (s) => s.sectionKey === "manual_review_required" || s.sectionKey === "appendix"
    );
    checks.push(check("has-executive", hasExec, "executive_summary"));
    checks.push(check("has-risk-matrix", hasRisk, "compliance_risk_matrix"));
    checks.push(check("has-manual-or-appendix", hasManual, "manual/appendix"));
  } else {
    issues.push("adapter");
    checks.push(check("reportspec-loaded", false, "missing reportSpec/deck"));
  }

  const pageCount = deckManifest?.slideCount ?? pngCount;
  const reasonablePages = pageCount >= 5 && pageCount <= 120;
  checks.push(check("page-count-reasonable", reasonablePages, `pages=${pageCount}`));

  // Visual issues are soft — blank-page heuristic via very small PNG sizes
  let visualIssues = false;
  if (existsSync(pagesDir)) {
    const pngs = readdirSync(pagesDir).filter((f) => f.endsWith(".png"));
    const tiny = pngs.filter((f) => statSync(join(pagesDir, f)).size < 2000);
    if (tiny.length > 0) {
      visualIssues = true;
      checks.push(check("no-tiny-blank-pngs", false, `tiny=${tiny.length}`));
    } else {
      checks.push(check("no-tiny-blank-pngs", true, "ok"));
    }
  }

  let verdict: RendererIntegrationVerdict = "RENDERER_INTEGRATION_READY";
  if (issues.includes("export")) verdict = "BLOCKED_RENDERER_EXPORT";
  else if (issues.includes("adapter")) verdict = "BLOCKED_REPORTSPEC_ADAPTER";
  else if (issues.includes("old-content")) verdict = "BLOCKED_RENDER_FROM_OLD_CONTENT";
  else if (issues.includes("text-leak")) verdict = "BLOCKED_CLIENT_TEXT_LEAK";
  else if (issues.includes("wrong-subject")) verdict = "BLOCKED_WRONG_SUBJECT_RENDERED";
  else if (issues.includes("pending")) verdict = "BLOCKED_PENDING_AS_CONFIRMED";
  else if (visualIssues || issues.includes("content")) {
    verdict = "RENDERER_INTEGRATION_READY_WITH_VISUAL_ISSUES";
  }

  const passed =
    verdict === "RENDERER_INTEGRATION_READY" ||
    verdict === "RENDERER_INTEGRATION_READY_WITH_VISUAL_ISSUES";

  return {
    version: "r10-9-renderer-integration-qa-v1",
    passed,
    verdict,
    issues,
    pageCount,
    pngCount,
    pdfBytes,
    pptxBytes,
    checks,
    contentInspection,
  };
}

export function writeRendererIntegrationQaReport(
  outputRoot: string,
  report?: ReturnType<typeof inspectRendererIntegrationQa>
): string {
  mkdirSync(outputRoot, { recursive: true });
  const data = report ?? inspectRendererIntegrationQa({ outputRoot });
  const out = join(outputRoot, "r10-9-renderer-integration-qa.json");
  writeFileSync(out, `${JSON.stringify({ ...data, generatedAt: new Date().toISOString() }, null, 2)}\n`, "utf-8");
  return out;
}
