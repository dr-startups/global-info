/**
 * First36 P0 acceptance gate — pure checks over deck/theme/assets/qa artifacts.
 */

import { hasDanglingSentenceTail, sanitizeClientLanguage } from "./client-language";

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
};

const FORBIDDEN =
  /\b(DEMO|debug|placeholder|TODO|FIXME|identity|related|sanctions\/watchlist|WRONG_SUBJECT|AMBIGUOUS|auditRunId|evidenceRef)\b|\bcompliance\b(?!-процедур)/i;

const EMPTY_STUB =
  /раздел будет дополнен|данных для полного заполнения слота пока недостаточно|placeholder/i;

export function inspectFirst36Acceptance(input: First36AcceptanceInput): {
  passed: boolean;
  issues: First36AcceptanceIssue[];
} {
  const issues: First36AcceptanceIssue[] = [];

  if (input.slideCount !== 36) {
    issues.push({
      code: "page-count",
      detail: `expected 36 slides, got ${input.slideCount}`,
    });
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

  const wikiWrong =
    String(input.themeSet?.ru?.wikipediaStatus ?? "").toUpperCase() === "WRONG_SUBJECT" ||
    String(input.themeSet?.uae?.wikipediaStatus ?? "").toUpperCase() === "WRONG_SUBJECT";

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
      wikiWrong &&
      /knowledge_panel|knowledge_visual/i.test(`${slide.template}`) &&
      /панель знаний|справочн|wikipedia/i.test(`${slide.title}`)
    ) {
      if (/статью о персоне|публичной статьи о персоне|о проверяем|о персоне/i.test(texts.join(" "))) {
        issues.push({
          code: "wrong-subject-as-knowledge-panel",
          page,
          detail: "WRONG_SUBJECT Wikipedia presented as subject knowledge panel",
        });
      }
    }
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

  return { passed: issues.length === 0, issues };
}
