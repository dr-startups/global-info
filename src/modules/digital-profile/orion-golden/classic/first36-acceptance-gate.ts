/**
 * First36 P0 acceptance gate — pure checks over deck/theme/assets/qa artifacts.
 */

import { hasDanglingSentenceTail, sanitizeClientLanguage } from "./client-language";
import { existsSync, readdirSync } from "node:fs";

export type First36AcceptanceIssue = {
  code: string;
  page?: number;
  detail: string;
};

export type First36AcceptanceInput = {
  slideCount: number;
  slides: Array<{
    pageNumber: number;
    title?: string;
    narrative?: string;
    bullets?: string[];
    template?: string;
    table?: { headers?: string[]; rows?: string[][] };
    clientTakeaway?: string;
    visualAnalysis?: {
      whatIsVisible?: string;
      whyItMatters?: string;
      clientMeaning?: string;
      headlineConclusion?: string;
    };
    statusBadge?: { label?: string };
    blockedReason?: string;
    assetRefs?: string[];
    evidenceRefs?: string[];
    factualClaims?: Array<{ text?: string; evidenceRefs?: string[] }>;
  }>;
  themeSet?: {
    ru?: { linksTotal?: number; linksAdverse?: number; wikipediaStatus?: string };
    uae?: { linksTotal?: number; linksAdverse?: number; wikipediaStatus?: string };
  };
  runScopedMerge?: {
    usedRunScoped?: boolean;
    duplicateKeys?: string[];
    observationCount?: number;
  };
  assetKinds?: string[];
  assets?: Array<{ assetRef: string; status?: string; evidenceRefs?: string[] }>;
  requiredVisualAssetRefs?: string[];
  typecheckPassed?: boolean;
  paths?: { pptx?: string; pdf?: string; pagesPngDir?: string };
  arsenkinRequired?: boolean;
  arsenkinEnrich?: { skipped?: boolean; mode?: string; blocked?: boolean; reason?: string };
  coverageSummary?: {
    reportRunId?: string;
    rows?: Array<{ reportRunId?: string; tool?: string; engine?: string; region?: string; surface?: string; status?: string }>;
  };
  expectedRunId?: string;
  geometryReport?: { overlaps?: unknown[]; overflow?: unknown[]; blank?: unknown[] };
  clientFinalize?: boolean;
  providerTasks?: Array<{ reportRunId?: string; state?: string }>;
};

const FORBIDDEN =
  /\b(DEMO|debug|placeholder|TODO|FIXME|identity|related|sanctions\/watchlist|WRONG_SUBJECT|AMBIGUOUS|auditRunId|evidenceRef)\b|\bcompliance\b(?!-процедур)/i;

const EMPTY_STUB =
  /раздел будет дополнен|данных для полного заполнения слота пока недостаточно|placeholder/i;

export function inspectFirst36Acceptance(input: First36AcceptanceInput): {
  passed: boolean;
  issues: First36AcceptanceIssue[];
  ceoReady: boolean;
} {
  const issues: First36AcceptanceIssue[] = [];

  if (input.typecheckPassed === false) {
    issues.push({ code: "typecheck-failed", detail: "typecheckPassed=false" });
  }
  if (input.slideCount !== 36) {
    issues.push({
      code: "page-count",
      detail: `expected 36 slides, got ${input.slideCount}`,
    });
  }
  if (input.slides.length !== 36) {
    issues.push({ code: "slide-object-count", detail: `expected 36 slide objects, got ${input.slides.length}` });
  }
  const pageNumbers = input.slides.map((s) => s.pageNumber);
  const expectedPages = Array.from({ length: 36 }, (_, i) => i + 1);
  if (
    pageNumbers.length !== 36 ||
    new Set(pageNumbers).size !== 36 ||
    expectedPages.some((page) => !pageNumbers.includes(page))
  ) {
    issues.push({ code: "page-numbers", detail: "pageNumber must be unique and cover 1..36" });
  }
  if (input.paths?.pptx && !existsSync(input.paths.pptx)) {
    issues.push({ code: "pptx-missing", detail: input.paths.pptx });
  }
  if (input.paths?.pdf && !existsSync(input.paths.pdf)) {
    issues.push({ code: "pdf-missing", detail: input.paths.pdf });
  }
  if (input.paths?.pagesPngDir) {
    const pngs = existsSync(input.paths.pagesPngDir)
      ? readdirSync(input.paths.pagesPngDir).filter((name) => /\.png$/i.test(name))
      : [];
    if (pngs.length !== 36) {
      issues.push({ code: "png-count", detail: `expected 36 PNGs, got ${pngs.length}` });
    }
  }
  if (input.runScopedMerge?.usedRunScoped !== true) {
    issues.push({ code: "run-scoped-required", detail: "usedRunScoped must be true" });
  }
  if ((input.runScopedMerge?.observationCount ?? 0) <= 0) {
    issues.push({ code: "observations-required", detail: "observationCount must be > 0" });
  }
  if (input.expectedRunId) {
    if (input.coverageSummary?.reportRunId && input.coverageSummary.reportRunId !== input.expectedRunId) {
      issues.push({ code: "foreign-coverage-run", detail: input.coverageSummary.reportRunId });
    }
    for (const row of input.coverageSummary?.rows ?? []) {
      if (row.reportRunId && row.reportRunId !== input.expectedRunId) {
        issues.push({ code: "foreign-coverage-run", detail: row.reportRunId });
        break;
      }
    }
    for (const task of input.providerTasks ?? []) {
      if (task.reportRunId && task.reportRunId !== input.expectedRunId) {
        issues.push({ code: "foreign-provider-task-run", detail: task.reportRunId });
        break;
      }
    }
  }
  if (input.arsenkinRequired) {
    if (input.arsenkinEnrich?.mode !== "live" || input.arsenkinEnrich?.skipped || input.arsenkinEnrich?.blocked) {
      issues.push({ code: "arsenkin-required-enrich", detail: input.arsenkinEnrich?.reason ?? "live enrichment required" });
    }
    if ((input.providerTasks ?? []).some((task) => /FAILED|CANCELLED|SUBMIT_UNKNOWN/i.test(String(task.state)))) {
      issues.push({ code: "arsenkin-task-failed", detail: "provider task failed/cancelled/submit unknown" });
    }
    const rows = input.coverageSummary?.rows ?? [];
    const has = (tool: string, engine: string, region: "RU" | "UAE", surface: string) =>
      rows.some(
        (r) =>
          r.tool === tool &&
          String(r.engine).toUpperCase() === engine &&
          r.surface === surface &&
          (region === "UAE" ? /UAE|AE|INTL/i.test(String(r.region)) : !/UAE|AE|INTL/i.test(String(r.region)))
      );
    for (const [tool, engine, region, surface] of [
      ["check-top", "GOOGLE", "RU", "organic"],
      ["suggest", "YANDEX", "RU", "autocomplete"],
      ["suggest", "GOOGLE", "RU", "autocomplete"],
      ["suggest", "GOOGLE", "UAE", "autocomplete"],
      ["paa", "GOOGLE", "RU", "paa"],
      ["paa", "GOOGLE", "UAE", "paa"],
    ] as const) {
      if (!has(tool, engine, region, surface)) {
        issues.push({ code: "arsenkin-coverage", detail: `${tool}:${engine}:${region}:${surface}` });
      }
    }
  }
  if (input.geometryReport) {
    for (const [name, values] of Object.entries(input.geometryReport)) {
      if (Array.isArray(values) && values.length > 0) {
        issues.push({ code: `geometry-${name}`, detail: `${values.length} geometry violations` });
      }
    }
  }
  const assetByRef = new Map((input.assets ?? []).map((asset) => [asset.assetRef, asset]));
  for (const ref of input.requiredVisualAssetRefs ?? []) {
    const asset = assetByRef.get(ref);
    if (!asset || asset.status !== "ready" || (asset.evidenceRefs?.length ?? 0) === 0) {
      issues.push({ code: "required-visual-asset", detail: ref });
    }
  }

  const ruTotal = Number(input.themeSet?.ru?.linksTotal ?? 0);
  const uaeTotal = Number(input.themeSet?.uae?.linksTotal ?? 0);
  if (ruTotal > 0 && uaeTotal > 0 && ruTotal === uaeTotal) {
    issues.push({
      code: "shared-kpi-denominator",
      detail: `RU and UAE share linksTotal=${ruTotal}`,
    });
  }

  if ((input.runScopedMerge?.duplicateKeys?.length ?? 0) > 0) {
    issues.push({
      code: "duplicate-observation-keys",
      detail: `${input.runScopedMerge!.duplicateKeys!.length} duplicate observation keys`,
    });
  }

  for (const slide of input.slides) {
    const page = slide.pageNumber;
    const texts = [
      slide.narrative,
      slide.clientTakeaway,
      ...(slide.bullets ?? []),
      slide.visualAnalysis?.whatIsVisible,
      slide.visualAnalysis?.whyItMatters,
      slide.visualAnalysis?.clientMeaning,
      slide.visualAnalysis?.headlineConclusion,
      slide.statusBadge?.label,
    ]
      .filter(Boolean)
      .map((t) => String(t));

    for (const t of texts) {
      if (hasDanglingSentenceTail(t)) {
        issues.push({ code: "dangling-sentence", page, detail: t.slice(-80) });
      }
      if (FORBIDDEN.test(t) && !/другой субъект/i.test(t)) {
        issues.push({
          code: "internal-label",
          page,
          detail: `forbidden token in: ${sanitizeClientLanguage(t).slice(0, 120)}`,
        });
      }
      if (EMPTY_STUB.test(t) && (page === 19 || page === 36 || /no_data|placeholder/i.test(slide.template ?? ""))) {
        issues.push({
          code: "empty-required-slot",
          page,
          detail: t.slice(0, 120),
        });
      }
    }
    if ((slide.factualClaims?.length ?? 0) > 0) {
      for (const claim of slide.factualClaims ?? []) {
        if (claim.text?.trim() && (claim.evidenceRefs?.length ?? 0) === 0) {
          issues.push({ code: "claim-without-evidence", page, detail: claim.text.slice(0, 120) });
        }
      }
    }
    if (slide.visualAnalysis && (slide.evidenceRefs?.length ?? 0) === 0) {
      issues.push({ code: "visual-analysis-without-evidence", page, detail: "visualAnalysis requires evidenceRefs" });
    }

    const headers = (slide.table?.headers ?? []).map((h) => String(h).toLowerCase());
    const rows = slide.table?.rows ?? [];
    if (
      /search_table/i.test(slide.template ?? "") &&
      rows.length > 0 &&
      headers.some((h) => /позиц|поз/.test(h)) &&
      !headers.some((h) => /запрос|query/.test(h))
    ) {
      const rankIdx = headers.findIndex((h) => /позиц|поз|rank/.test(h));
      const ranks = rows.map((r) => String(r[Math.max(0, rankIdx)] ?? ""));
      const dup = ranks.filter((r, i) => r && ranks.indexOf(r) !== i);
      if (dup.length > 0) {
        issues.push({
          code: "serp-rank-without-query",
          page,
          detail: `duplicate ranks without query column: ${[...new Set(dup)].join(",")}`,
        });
      }
    }

    if (
      /knowledge_panel|knowledge_visual/i.test(`${slide.template}`) &&
      /панель знаний|справочн|wikipedia/i.test(`${slide.title ?? ""}`)
    ) {
      const titleBlob = `${slide.title ?? ""}`;
      const region: "RU" | "UAE" | null = /оаэ|uae/i.test(titleBlob)
        ? "UAE"
        : /россия|\bru\b/i.test(titleBlob)
          ? "RU"
          : page >= 23
            ? "UAE"
            : page >= 18 && page <= 19
              ? "RU"
              : null;
      const regionStatus = String(
        (region === "UAE" ? input.themeSet?.uae?.wikipediaStatus : input.themeSet?.ru?.wikipediaStatus) ??
          ""
      ).toUpperCase();
      const blob = texts.join(" ");
      // Only fail WRONG_SUBJECT regions whose copy still claims a subject profile article.
      if (
        regionStatus === "WRONG_SUBJECT" &&
        /публичной статьи о (?:персоне|проверяемом)|статью о персоне|о проверяемом лице/i.test(blob) &&
        !/не относится|другого (?:лица|субъекта)|нельзя засчитывать|не найдена|отсутствует/i.test(blob)
      ) {
        issues.push({
          code: "wrong-subject-as-knowledge-panel",
          page,
          detail: "WRONG_SUBJECT Wikipedia presented as subject knowledge panel",
        });
      }
    }
  }

  for (const page of [19, 36]) {
    const slide = input.slides.find((s) => s.pageNumber === page);
    const content = [slide?.title, slide?.narrative, ...(slide?.bullets ?? []), slide?.clientTakeaway]
      .filter(Boolean)
      .join(" ")
      .trim();
    if (!content) issues.push({ code: "empty-required-slide", page, detail: `page ${page} has no content` });
  }

  // Related pages 20–22 must not share identical analysis blobs.
  const related = input.slides.filter((s) => s.pageNumber >= 20 && s.pageNumber <= 22);
  if (related.length >= 2) {
    const blobs = related.map(
      (s) =>
        `${s.visualAnalysis?.whatIsVisible ?? ""}|${s.visualAnalysis?.whyItMatters ?? ""}|${s.clientTakeaway ?? ""}`
    );
    if (blobs[0] && blobs.every((b) => b === blobs[0])) {
      issues.push({
        code: "identical-related-sidebars",
        detail: "pages 20–22 share identical sidebar analysis",
      });
    }
  }

  const passed = issues.length === 0;
  return { passed, issues, ceoReady: passed && input.clientFinalize === true };
}
