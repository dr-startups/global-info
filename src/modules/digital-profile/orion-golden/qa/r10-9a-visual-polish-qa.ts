/**
 * R10.9a — Page-by-page visual review + polish QA.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { OrionGoldenDeckManifest } from "../composer/orion-deck-composer";
import type { OrionGoldenReportSpec } from "../report-spec/orion-report-spec";
import { ORION_GOLDEN_FORBIDDEN_RAW_TOKENS } from "../client/client-text-sanitizer";

export type PageVisualGrade = "PASS" | "MINOR_ISSUE" | "MAJOR_ISSUE" | "BLOCKER";

export type VisualPolishVerdict =
  | "VISUAL_POLISH_READY"
  | "VISUAL_POLISH_READY_WITH_MINOR_ISSUES"
  | "BLOCKED_TEXT_CLIPPING"
  | "BLOCKED_TABLE_OVERFLOW"
  | "BLOCKED_EMPTY_OR_FILLER_PAGES"
  | "BLOCKED_CLIENT_TEXT_LEAK"
  | "BLOCKED_WRONG_SUBJECT_RENDERED"
  | "BLOCKED_PENDING_AS_CONFIRMED"
  | "BLOCKED_RENDER_EXPORT";

function check(id: string, passed: boolean, detail: string) {
  return { id, passed, detail };
}

function gradePage(input: {
  pageNumber: number;
  sectionKey: string;
  template: string;
  title: string;
  bullets?: string[];
  bulletCount: number;
  narrativeLen: number;
  pngBytes: number;
}): { grade: PageVisualGrade; notes: string[] } {
  const notes: string[] = [];
  let grade: PageVisualGrade = "PASS";

  if (input.pngBytes < 2500) {
    notes.push("suspected blank/near-blank page");
    grade = "BLOCKER";
  }
  // Dense narrative on audit slides historically caused overlap
  if (input.narrativeLen > 1200 && input.bulletCount > 0) {
    notes.push("long narrative + bullets risk overlap");
    grade = grade === "BLOCKER" ? grade : "MAJOR_ISSUE";
  }
  if (input.bulletCount > 10) {
    notes.push("too many bullets for one slide");
    grade = grade === "PASS" ? "MINOR_ISSUE" : grade;
  }
  if (
    /\[object Object\]/i.test(input.title) ||
    (input.bullets ?? []).some((b) => /\[object Object\]/i.test(b))
  ) {
    notes.push("object Object leak");
    grade = "BLOCKER";
  }
  if (
    ["product_overview", "about", "solution_digital_profile"].includes(input.sectionKey)
  ) {
    notes.push("commercial slide present");
    grade = "BLOCKER";
  }
  if (input.sectionKey === "compliance_risk_matrix" && input.bulletCount === 0) {
    notes.push("empty risk matrix");
    grade = grade === "PASS" ? "MINOR_ISSUE" : grade;
  }
  if (
    (input.sectionKey === "manual_review_required" || input.sectionKey === "appendix") &&
    input.narrativeLen > 2000
  ) {
    notes.push("manual/appendix narrative dump");
    grade = grade === "BLOCKER" ? grade : "MAJOR_ISSUE";
  }
  // Cover whitespace is intentional
  if (input.sectionKey === "cover" && input.pngBytes < 40000) {
    notes.push("sparse cover (acceptable)");
  }
  return { grade, notes };
}

export function buildPageVisualReview(input: {
  outputRoot: string;
  deckManifest?: OrionGoldenDeckManifest;
}): {
  version: "r10-9a-page-visual-review-v1";
  pageCount: number;
  counts: Record<PageVisualGrade, number>;
  pages: Array<{
    pageNumber: number;
    sectionKey: string;
    template: string;
    title: string;
    grade: PageVisualGrade;
    notes: string[];
    pngBytes: number;
  }>;
} {
  const root = input.outputRoot;
  const deckPath = join(root, "final-deck-manifest.json");
  const deck =
    input.deckManifest ??
    (existsSync(deckPath)
      ? (JSON.parse(readFileSync(deckPath, "utf-8")) as OrionGoldenDeckManifest)
      : null);
  const pagesDir = join(root, "pages-png");
  const pngFiles = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => f.endsWith(".png")).sort()
    : [];

  const pages: Array<{
    pageNumber: number;
    sectionKey: string;
    template: string;
    title: string;
    grade: PageVisualGrade;
    notes: string[];
    pngBytes: number;
  }> = [];

  const slides = deck?.finalSlides ?? [];
  const n = Math.max(slides.length, pngFiles.length);
  for (let i = 0; i < n; i += 1) {
    const slide = slides[i];
    const pngName = pngFiles[i] ?? `page-${String(i + 1).padStart(2, "0")}.png`;
    const pngPath = join(pagesDir, pngName);
    const pngBytes = existsSync(pngPath) ? statSync(pngPath).size : 0;
    const graded = gradePage({
      pageNumber: i + 1,
      sectionKey: slide?.sectionKey ?? "unknown",
      template: slide?.template ?? "unknown",
      title: slide?.title ?? "",
      bullets: slide?.bullets,
      bulletCount: slide?.bullets?.length ?? 0,
      narrativeLen: slide?.narrative?.length ?? 0,
      pngBytes,
    });
    pages.push({
      pageNumber: i + 1,
      sectionKey: slide?.sectionKey ?? "unknown",
      template: slide?.template ?? "unknown",
      title: slide?.title ?? "",
      grade: graded.grade,
      notes: graded.notes,
      pngBytes,
    });
  }

  const counts: Record<PageVisualGrade, number> = {
    PASS: 0,
    MINOR_ISSUE: 0,
    MAJOR_ISSUE: 0,
    BLOCKER: 0,
  };
  for (const p of pages) counts[p.grade] += 1;

  return {
    version: "r10-9a-page-visual-review-v1",
    pageCount: pages.length,
    counts,
    pages,
  };
}

export function inspectVisualPolishQa(input: { outputRoot: string }): {
  version: "r10-9a-visual-polish-qa-v1";
  passed: boolean;
  verdict: VisualPolishVerdict;
  issues: string[];
  pageCount: number;
  pngCount: number;
  pdfBytes: number;
  pptxBytes: number;
  pageReview: ReturnType<typeof buildPageVisualReview>;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
} {
  const root = input.outputRoot;
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const pdfPath = join(root, "rendered-client.pdf");
  const pptxPath = join(root, "rendered-client.pptx");
  const pagesDir = join(root, "pages-png");
  const specPath = existsSync(join(root, "orion-report-spec.from-client-content.json"))
    ? join(root, "orion-report-spec.from-client-content.json")
    : join(root, "orion-report-spec.json");
  const deckPath = join(root, "final-deck-manifest.json");

  const pdfOk = existsSync(pdfPath) && statSync(pdfPath).size > 1000;
  const pptxOk = existsSync(pptxPath) && statSync(pptxPath).size > 1000;
  const pdfBytes = pdfOk ? statSync(pdfPath).size : 0;
  const pptxBytes = pptxOk ? statSync(pptxPath).size : 0;
  checks.push(check("pdf-exists", pdfOk, pdfPath));
  checks.push(check("pptx-exists", pptxOk, pptxPath));
  if (!pdfOk || !pptxOk) issues.push("export");

  const pngCount = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length
    : 0;
  checks.push(check("png-previews", pngCount > 0, `count=${pngCount}`));
  if (pngCount === 0) issues.push("export");

  const pageReview = buildPageVisualReview({ outputRoot: root });
  checks.push(
    check(
      "no-blockers",
      pageReview.counts.BLOCKER === 0,
      `blockers=${pageReview.counts.BLOCKER}`
    )
  );
  checks.push(
    check(
      "no-major-issues",
      pageReview.counts.MAJOR_ISSUE === 0,
      `major=${pageReview.counts.MAJOR_ISSUE}`
    )
  );
  if (pageReview.counts.BLOCKER > 0) issues.push("clipping");
  else if (pageReview.counts.MAJOR_ISSUE > 0) issues.push("clipping");

  let reportSpec: OrionGoldenReportSpec | null = null;
  let deck: OrionGoldenDeckManifest | null = null;
  if (existsSync(specPath)) reportSpec = JSON.parse(readFileSync(specPath, "utf-8"));
  if (existsSync(deckPath)) deck = JSON.parse(readFileSync(deckPath, "utf-8"));

  if (reportSpec && deck) {
    const fromClient =
      reportSpec.qaMetadata.architectureVersion.includes("r10-9") ||
      reportSpec.qaMetadata.warnings.some((w) => w.includes("client_audit_render"));
    checks.push(check("post-review-source", fromClient, reportSpec.qaMetadata.architectureVersion));

    const commercial = deck.finalSlides.some((s) =>
      ["product_overview", "about", "solution_digital_profile"].includes(s.sectionKey)
    );
    checks.push(check("no-commercial", !commercial, `commercial=${commercial}`));
    if (commercial) issues.push("commercial");

    const text = [
      reportSpec.executiveSummary.executiveSummary,
      ...deck.finalSlides.flatMap((s) => [s.title, s.narrative ?? "", ...(s.bullets ?? [])]),
    ]
      .join("\n")
      .toLowerCase();

    const leaks = ORION_GOLDEN_FORBIDDEN_RAW_TOKENS.filter((t) => text.includes(t.toLowerCase()));
    checks.push(check("no-text-leaks", leaks.length === 0, leaks.slice(0, 5).join(",") || "none"));
    if (leaks.length) issues.push("text-leak");

    const wrong = /wrong_subject/.test(text);
    checks.push(check("no-wrong-subject", !wrong, `wrong=${wrong}`));
    if (wrong) issues.push("wrong-subject");

    const pendingOk =
      /требует проверки|ручной проверк/.test(text) &&
      !/pending.*(confirmed|подтвержд)/i.test(text);
    checks.push(check("pending-caveated", pendingOk, `pendingOk=${pendingOk}`));
    if (!pendingOk) issues.push("pending");

    const hasRisk = deck.finalSlides.some((s) => s.sectionKey === "compliance_risk_matrix");
    const hasManual = deck.finalSlides.some((s) => s.sectionKey === "manual_review_required");
    const hasAppendix = deck.finalSlides.some((s) => s.sectionKey === "appendix");
    checks.push(check("risk-matrix-present", hasRisk, "compliance_risk_matrix"));
    checks.push(check("manual-review-present", hasManual, "manual_review_required"));
    checks.push(check("appendix-present", hasAppendix, "appendix"));

    const denseNarrative = deck.finalSlides.filter(
      (s) => (s.narrative?.length ?? 0) > 1200 && (s.bullets?.length ?? 0) > 0
    ).length;
    checks.push(
      check("no-dense-narrative-dumps", denseNarrative === 0, `dense=${denseNarrative}`)
    );
    if (denseNarrative > 0) issues.push("clipping");
  }

  const reasonable = pageReview.pageCount >= 8 && pageReview.pageCount <= 80;
  checks.push(check("page-count-reasonable", reasonable, `pages=${pageReview.pageCount}`));

  let verdict: VisualPolishVerdict = "VISUAL_POLISH_READY";
  if (issues.includes("export")) verdict = "BLOCKED_RENDER_EXPORT";
  else if (issues.includes("text-leak")) verdict = "BLOCKED_CLIENT_TEXT_LEAK";
  else if (issues.includes("wrong-subject")) verdict = "BLOCKED_WRONG_SUBJECT_RENDERED";
  else if (issues.includes("pending")) verdict = "BLOCKED_PENDING_AS_CONFIRMED";
  else if (pageReview.counts.BLOCKER > 0) verdict = "BLOCKED_TEXT_CLIPPING";
  else if (pageReview.counts.MAJOR_ISSUE > 0) verdict = "BLOCKED_TEXT_CLIPPING";
  else if (pageReview.counts.MINOR_ISSUE > 0) verdict = "VISUAL_POLISH_READY_WITH_MINOR_ISSUES";

  const passed =
    verdict === "VISUAL_POLISH_READY" || verdict === "VISUAL_POLISH_READY_WITH_MINOR_ISSUES";

  return {
    version: "r10-9a-visual-polish-qa-v1",
    passed,
    verdict,
    issues,
    pageCount: pageReview.pageCount,
    pngCount,
    pdfBytes,
    pptxBytes,
    pageReview,
    checks,
  };
}

export function writeVisualPolishQaArtifacts(outputRoot: string): {
  pageReviewPath: string;
  qaPath: string;
  report: ReturnType<typeof inspectVisualPolishQa>;
} {
  mkdirSync(outputRoot, { recursive: true });
  const report = inspectVisualPolishQa({ outputRoot });
  const pageReviewPath = join(outputRoot, "r10-9a-page-visual-review.json");
  const qaPath = join(outputRoot, "r10-9a-visual-polish-qa.json");
  writeFileSync(
    pageReviewPath,
    `${JSON.stringify({ ...report.pageReview, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf-8"
  );
  writeFileSync(
    qaPath,
    `${JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2)}\n`,
    "utf-8"
  );
  return { pageReviewPath, qaPath, report };
}
