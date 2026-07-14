/**
 * First36 P0 acceptance gate — pure checks over deck/theme/assets/qa artifacts.
 */

import { hasDanglingSentenceTail, sanitizeClientLanguage } from "./client-language";
import { existsSync, readdirSync } from "node:fs";
import { ORION_FIRST36_REGISTRY_V1 } from "./orion-first36-registry.v1";

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
    rows?: Array<{
      reportRunId?: string;
      tool?: string;
      engine?: string;
      region?: string;
      surface?: string;
      status?: string;
      providerTaskId?: string | null;
    }>;
  };
  expectedRunId?: string;
  geometryReport?: {
    overlaps?: unknown[];
    overflow?: unknown[];
    clipping?: unknown[];
    blank?: unknown[];
    missingAssets?: unknown[];
    emptyContent?: unknown[];
    emptyPages?: unknown[];
    summary?: { issueCount?: number; severity?: string; pageCount?: number };
    inspectorError?: string | null;
    inspectorVersion?: string;
  } | null;
  /** When false/undefined in ARSENKIN_REQUIRED mode, geometry is treated as missing. */
  geometryReportPresent?: boolean;
  clientFinalize?: boolean;
  providerTasks?: Array<{ reportRunId?: string; state?: string; id?: string }>;
  observations?: Array<{
    auditRunId?: string;
    provider?: string;
    providerTaskId?: string | null;
  }>;
  provenanceSummary?: {
    linkedObservations?: number;
    totalObservations?: number;
    linkedCoverage?: number;
    totalCoverage?: number;
  };
  /** Original client-content reportRunId before any override. */
  clientContentSourceReportRunId?: string | null;
  /** Admin review decisions used for client-final content (when present). */
  adminDecisionSet?: {
    qaSampleOnly?: boolean;
    decisions?: Array<{ reviewedBy?: string; reviewerNote?: string }>;
  };
};

const FORBIDDEN =
  /\b(DEMO|debug|placeholder|TODO|FIXME|identity|related|sanctions\/watchlist|WRONG_SUBJECT|AMBIGUOUS|auditRunId|evidenceRef)\b|\bcompliance\b(?!-процедур)/i;

const EMPTY_STUB =
  /раздел будет дополнен|данных для полного заполнения слота пока недостаточно|placeholder/i;

const INCOMPLETE_TASK =
  /^(QUEUED|RUNNING|RATE_LIMITED|SUBMITTING|FAILED|CANCELLED|SUBMIT_UNKNOWN)$/i;

/** Resolve required visual asset refs from First36 registry against available assets. */
export function requiredVisualAssetRefsFromRegistry(
  assets: Array<{ assetRef: string }>
): string[] {
  const refs = assets.map((a) => a.assetRef);
  const required: string[] = [];
  for (const slot of ORION_FIRST36_REGISTRY_V1) {
    if (!slot.requiredVisual || !slot.match.assetRefRe) continue;
    const match = refs.find((ref) => slot.match.assetRefRe!.test(ref));
    if (match) required.push(match);
    else required.push(`missing:${slot.slotId}`);
  }
  return [...new Set(required)];
}

export function inspectFirst36Acceptance(input: First36AcceptanceInput): {
  passed: boolean;
  issues: First36AcceptanceIssue[];
  ceoReady: boolean;
} {
  const issues: First36AcceptanceIssue[] = [];
  const requiredVisualRefs =
    input.requiredVisualAssetRefs ??
    (input.arsenkinRequired || input.clientFinalize
      ? requiredVisualAssetRefsFromRegistry(input.assets ?? [])
      : []);

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

  const requireArtifacts = Boolean(input.arsenkinRequired || input.clientFinalize);
  if (requireArtifacts) {
    if (!input.paths?.pptx || !existsSync(input.paths.pptx)) {
      issues.push({ code: "pptx-missing", detail: input.paths?.pptx ?? "pptx path unset" });
    }
    if (!input.paths?.pdf || !existsSync(input.paths.pdf)) {
      issues.push({ code: "pdf-missing", detail: input.paths?.pdf ?? "pdf path unset" });
    }
    if (!input.paths?.pagesPngDir) {
      issues.push({ code: "png-count", detail: "pagesPngDir unset" });
    } else {
      const pngs = existsSync(input.paths.pagesPngDir)
        ? readdirSync(input.paths.pagesPngDir).filter((name) => /\.png$/i.test(name))
        : [];
      if (pngs.length !== 36) {
        issues.push({ code: "png-count", detail: `expected 36 PNGs, got ${pngs.length}` });
      }
    }
  } else {
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
    for (const obs of input.observations ?? []) {
      if (obs.auditRunId && obs.auditRunId !== input.expectedRunId) {
        issues.push({ code: "foreign-observation-run", detail: obs.auditRunId });
        break;
      }
    }
    if (
      input.clientContentSourceReportRunId &&
      input.clientContentSourceReportRunId !== input.expectedRunId
    ) {
      issues.push({
        code: "foreign-client-content-run",
        detail: input.clientContentSourceReportRunId,
      });
    }
    if (input.clientFinalize && input.adminDecisionSet?.qaSampleOnly === true) {
      issues.push({
        code: "qa-sample-decisions-forbidden",
        detail: "qaSampleOnly=true admin decisions cannot be used in client-final",
      });
    }
    if (input.clientFinalize && input.adminDecisionSet?.decisions) {
      for (const decision of input.adminDecisionSet.decisions) {
        const reviewer = String(decision.reviewedBy ?? "");
        const note = String(decision.reviewerNote ?? "");
        if (
          reviewer === "qa-fixture-analyst" ||
          /qa[- ]?fixture/i.test(reviewer) ||
          /qa[- ]?fixture/i.test(note)
        ) {
          issues.push({
            code: "qa-fixture-reviewer-forbidden",
            detail: reviewer || note.slice(0, 80) || "qa-fixture reviewer",
          });
          break;
        }
      }
    }
  }

  if (input.arsenkinRequired) {
    if (input.arsenkinEnrich?.mode !== "live" || input.arsenkinEnrich?.blocked) {
      issues.push({ code: "arsenkin-required-enrich", detail: input.arsenkinEnrich?.reason ?? "live enrichment required" });
    } else if (
      input.arsenkinEnrich?.skipped &&
      !/already_enriched|surfaces_complete/i.test(String(input.arsenkinEnrich?.reason ?? ""))
    ) {
      issues.push({ code: "arsenkin-required-enrich", detail: input.arsenkinEnrich?.reason ?? "live enrichment required" });
    }
    const tasks = input.providerTasks ?? [];
    if (tasks.length === 0) {
      issues.push({ code: "arsenkin-tasks-missing", detail: "provider tasks required" });
    }
    for (const task of tasks) {
      if (!/^DONE$/i.test(String(task.state ?? ""))) {
        issues.push({
          code: INCOMPLETE_TASK.test(String(task.state ?? ""))
            ? "arsenkin-task-incomplete"
            : "arsenkin-task-failed",
          detail: `${task.id ?? "task"}:${task.state ?? "missing"}`,
        });
        break;
      }
    }
    const rows = input.coverageSummary?.rows ?? [];
    for (const row of rows) {
      if (!row.providerTaskId) {
        issues.push({ code: "coverage-missing-provider-task", detail: `${row.tool}:${row.surface}` });
        break;
      }
      if (!/^(OK|NO_RESULTS)$/i.test(String(row.status ?? ""))) {
        issues.push({ code: "coverage-invalid-status", detail: `${row.tool}:${row.status}` });
        break;
      }
    }
    const arsenkinObs = (input.observations ?? []).filter((o) => /arsenkin/i.test(String(o.provider ?? "arsenkin")));
    for (const obs of arsenkinObs) {
      if (!obs.providerTaskId) {
        issues.push({ code: "observation-missing-provider-task", detail: "null providerTaskId" });
        break;
      }
    }
    const linkedObs =
      input.provenanceSummary?.linkedObservations ??
      arsenkinObs.filter((o) => Boolean(o.providerTaskId)).length;
    const totalObs = input.provenanceSummary?.totalObservations ?? arsenkinObs.length;
    if (totalObs > 0 && linkedObs < totalObs) {
      issues.push({
        code: "observation-provenance-incomplete",
        detail: `${linkedObs}/${totalObs}`,
      });
    }
    const linkedCov =
      input.provenanceSummary?.linkedCoverage ??
      rows.filter((r) => Boolean(r.providerTaskId)).length;
    const totalCov = input.provenanceSummary?.totalCoverage ?? rows.length;
    if (totalCov > 0 && linkedCov < totalCov) {
      issues.push({
        code: "coverage-provenance-incomplete",
        detail: `${linkedCov}/${totalCov}`,
      });
    }
    const has = (tool: string, engine: string, region: "RU" | "UAE", surface: string) =>
      rows.some(
        (r) =>
          r.tool === tool &&
          String(r.engine).toUpperCase() === engine &&
          r.surface === surface &&
          /^(OK|NO_RESULTS)$/i.test(String(r.status ?? "")) &&
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

    const geometryPresent =
      input.geometryReportPresent === true ||
      (input.geometryReportPresent !== false && input.geometryReport != null);
    if (!geometryPresent || !input.geometryReport) {
      issues.push({ code: "geometry-missing", detail: "geometry-report.json required" });
    } else {
      const geo = input.geometryReport;
      if (geo.inspectorError) {
        issues.push({ code: "geometry-inspector-error", detail: String(geo.inspectorError) });
      }
      const severity = String(geo.summary?.severity ?? "").toUpperCase();
      if (severity === "BLOCKER" || severity === "CRITICAL") {
        issues.push({
          code: "geometry-severity",
          detail: `${severity}: issueCount=${geo.summary?.issueCount ?? "?"}`,
        });
      }
      for (const [name, values] of Object.entries(geo)) {
        if (
          ["overlaps", "overflow", "clipping", "blank", "missingAssets", "emptyContent", "emptyPages"].includes(
            name
          ) &&
          Array.isArray(values) &&
          values.length > 0
        ) {
          issues.push({ code: `geometry-${name}`, detail: `${values.length} geometry violations` });
        }
      }
    }
  } else if (input.geometryReport) {
    const geo = input.geometryReport;
    const severity = String(geo.summary?.severity ?? "").toUpperCase();
    if (severity === "BLOCKER" || severity === "CRITICAL") {
      issues.push({
        code: "geometry-severity",
        detail: `${severity}: issueCount=${geo.summary?.issueCount ?? "?"}`,
      });
    }
    for (const [name, values] of Object.entries(geo)) {
      if (
        ["overlaps", "overflow", "clipping", "blank", "missingAssets", "emptyContent", "emptyPages"].includes(
          name
        ) &&
        Array.isArray(values) &&
        values.length > 0
      ) {
        issues.push({ code: `geometry-${name}`, detail: `${values.length} geometry violations` });
      }
    }
  }

  const assetByRef = new Map((input.assets ?? []).map((asset) => [asset.assetRef, asset]));
  for (const ref of requiredVisualRefs) {
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
  const foreignClient =
    Boolean(input.expectedRunId) &&
    Boolean(input.clientContentSourceReportRunId) &&
    input.clientContentSourceReportRunId !== input.expectedRunId;
  return {
    passed,
    issues,
    ceoReady: passed && input.clientFinalize === true && !foreignClient,
  };
}
