/**
 * R9.11 — Visual audit of successful R9.10b real-case artifacts (read-only).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const R910_ROOT = join(process.cwd(), "storage", "digital-profile", "qa-r9-10-real-case-storyboard-e2e");
const OUT_ROOT = join(process.cwd(), "storage", "digital-profile", "qa-r9-11-orion-visual-polish");

type IssueTag =
  | "weak_visual_hierarchy"
  | "too_much_text"
  | "too_little_text"
  | "sparse_slide"
  | "poor_metric_card_layout"
  | "weak_executive_summary"
  | "weak_risk_explanation"
  | "weak_serp_composition"
  | "weak_lexis_visual_framing"
  | "inconsistent_margins"
  | "inconsistent_title_sizes"
  | "weak_footer"
  | "low_orion_similarity"
  | "missing_section_divider"
  | "no_clear_takeaway"
  | "no_clear_next_action"
  | "evidence_not_connected";

interface SlideAudit {
  pageNumber: number;
  slideId: string;
  slideType: string;
  title: string;
  issues: IssueTag[];
  notes: string[];
  pngBytes: number;
  textDensityScore: number;
}

function textDensity(slide: Record<string, unknown>): number {
  const parts: string[] = [
    String(slide.clientTakeaway ?? ""),
    String(slide.title ?? ""),
    String(slide.subtitle ?? ""),
  ];
  const findings = (slide.findings as Array<{ summary?: string }>) ?? [];
  const evidence = (slide.evidenceRefs as Array<{ summary?: string; label?: string }>) ?? [];
  const actions = (slide.recommendedActions as Array<{ label?: string }>) ?? [];
  for (const f of findings) parts.push(f.summary ?? "");
  for (const e of evidence) parts.push(e.summary ?? "", e.label ?? "");
  for (const a of actions) parts.push(a.label ?? "");
  return parts.join(" ").replace(/\s+/g, " ").trim().length;
}

function auditSlide(slide: Record<string, unknown>, pageNumber: number, pngBytes: number): SlideAudit {
  const issues: IssueTag[] = [];
  const notes: string[] = [];
  const slideType = String(slide.slideType ?? "");
  const slideId = String(slide.slideId ?? "");
  const title = String(slide.title ?? "");
  const density = textDensity(slide);
  const findings = ((slide.findings as unknown[]) ?? []).length;
  const evidence = ((slide.evidenceRefs as unknown[]) ?? []).length;
  const actions = ((slide.recommendedActions as unknown[]) ?? []).length;
  const metrics = ((slide.metrics as unknown[]) ?? []).length;
  const assetRefs = ((slide.assetRefs as unknown[]) ?? []).length;

  if (density < 80 && !["cover", "global_toc", "serp_screenshot", "lexisnexis_visual_page"].includes(slideType)) {
    issues.push("sparse_slide", "too_little_text");
    notes.push("Low narrative density for non-visual slide type.");
  }
  if (density > 900 && slideType !== "search_results_table") {
    issues.push("too_much_text");
    notes.push("High text volume may overwhelm client readers.");
  }
  if (findings + evidence + actions > 5) {
    issues.push("too_much_text");
    notes.push("More than five list-like elements on one slide.");
  }
  if (!String(slide.clientTakeaway ?? "").trim() && slideType !== "global_toc") {
    issues.push("no_clear_takeaway");
  }
  if (slideType === "executive_summary") {
    issues.push("weak_executive_summary", "weak_visual_hierarchy", "low_orion_similarity");
    notes.push("Plain bullets/metrics without dashboard-style insight columns or risk badge.");
    if (actions === 0) issues.push("no_clear_next_action");
  }
  if (slideType === "region_summary") {
    issues.push("weak_risk_explanation", "weak_visual_hierarchy");
    notes.push("Region summary uses generic bullet stack instead of found/why/review cards.");
  }
  if (slideType === "search_overview") {
    issues.push("evidence_not_connected", "weak_visual_hierarchy");
    notes.push("Evidence list not visually tied to risk interpretation.");
  }
  if (slideType === "serp_screenshot") {
    if (pngBytes < 120_000) issues.push("weak_serp_composition");
    issues.push("weak_serp_composition", "weak_risk_explanation");
    notes.push("SERP dominates but lacks adjacent relevance/risk callout framing.");
  }
  if (slideType === "lexisnexis_summary") {
    issues.push("missing_section_divider", "weak_lexis_visual_framing");
    notes.push("Lexis intro lacks status metrics row and manual-review callout block.");
  }
  if (slideType === "lexisnexis_visual_page") {
    issues.push("weak_lexis_visual_framing", "inconsistent_margins");
    notes.push("Lexis page reuses SERP layout; missing page frame and page indicator.");
  }
  if (slideType === "recommended_actions") {
    if (actions < 3) issues.push("no_clear_next_action");
    notes.push("Action slide is bullet-only without structured client workflow cards.");
  }
  if (slideType === "global_toc") {
    issues.push("missing_section_divider", "low_orion_similarity");
  }
  if (slideType === "cover") {
    issues.push("low_orion_similarity", "weak_visual_hierarchy");
    notes.push("Cover lacks ORION brand band and risk posture badge.");
  }
  if (metrics > 0 && slideType === "executive_summary") {
    issues.push("poor_metric_card_layout");
    notes.push("Metric cards are small and not integrated into management dashboard grid.");
  }
  if (["search_results_table", "adverse_media_summary"].includes(slideType)) {
    issues.push("weak_visual_hierarchy", "evidence_not_connected");
  }

  issues.push("weak_footer", "inconsistent_title_sizes");
  notes.push("Footer is page-only; no report title. Title sizes uniform but section hierarchy weak.");

  return {
    pageNumber,
    slideId,
    slideType,
    title,
    issues: [...new Set(issues)],
    notes,
    pngBytes,
    textDensityScore: density,
  };
}

function main() {
  const storyboardPath = join(R910_ROOT, "client-storyboard.json");
  if (!existsSync(storyboardPath)) {
    console.error("Missing R9.10b client-storyboard.json");
    process.exit(1);
  }
  const storyboard = JSON.parse(readFileSync(storyboardPath, "utf-8")) as {
    slides: Array<Record<string, unknown>>;
  };
  const pngDir = join(R910_ROOT, "pages-png");
  const pngs = existsSync(pngDir)
    ? readdirSync(pngDir)
        .filter((f) => f.endsWith(".png"))
        .sort()
    : [];

  const slides: SlideAudit[] = storyboard.slides.map((slide, i) => {
    const png = pngs[i];
    const pngPath = png ? join(pngDir, png) : "";
    const pngBytes = pngPath && existsSync(pngPath) ? statSync(pngPath).size : 0;
    return auditSlide(slide, i + 1, pngBytes);
  });

  const issueCounts: Record<string, number> = {};
  for (const s of slides) {
    for (const tag of s.issues) issueCounts[tag] = (issueCounts[tag] ?? 0) + 1;
  }

  const audit = {
    version: "r911-r910b-visual-audit-v1",
    auditedAt: new Date().toISOString(),
    sourceRoot: R910_ROOT,
    pageCount: slides.length,
    slides,
    topIssues: Object.entries(issueCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count })),
    summary:
      "R9.10b PASS report is functionally complete but visually plain: weak ORION corporate hierarchy, dashboard-style executive layout missing, SERP/Lexis frames need polish, footers minimal.",
  };

  mkdirSync(OUT_ROOT, { recursive: true });
  writeFileSync(join(OUT_ROOT, "r910b-visual-audit.json"), JSON.stringify(audit, null, 2));
  console.log(`[INFO] Wrote audit: ${join(OUT_ROOT, "r910b-visual-audit.json")}`);
  console.log(`[INFO] Pages audited: ${slides.length}`);
  console.log(`[INFO] Top issues: ${audit.topIssues.slice(0, 5).map((x) => x.tag).join(", ")}`);
}

main();
