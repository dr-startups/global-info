/**
 * Cross-slide KPI / evidence consistency checks (spec §9/§13).
 */

import type { OrionThemeSet } from "./orion-classic-theme-set";
import type { OrionGoldenDeckSlide } from "../composer/orion-deck-composer";

export type MetricConsistencyIssue = {
  code: string;
  detail: string;
  page?: number;
  slotId?: string;
};

function slideTexts(slide: OrionGoldenDeckSlide): string {
  return [
    slide.title,
    slide.narrative,
    slide.clientTakeaway,
    ...(slide.bullets ?? []),
    slide.visualAnalysis?.whatIsVisible,
    slide.visualAnalysis?.whyItMatters,
  ]
    .filter(Boolean)
    .join(" ");
}

function countSuggestionRows(slide: OrionGoldenDeckSlide): number {
  const table = slide.table?.rows?.length ?? 0;
  const bullets = slide.bullets?.length ?? 0;
  const meta = (slide as { suggestionCount?: number }).suggestionCount;
  return Math.max(table, bullets, meta ?? 0);
}

function countRelatedRows(slide: OrionGoldenDeckSlide): number {
  return slide.table?.rows?.length ?? slide.bullets?.length ?? 0;
}

function countImageHighlights(slide: OrionGoldenDeckSlide): number {
  const exp = slide.visualAnalysis?.highlightExplanations?.length ?? 0;
  const framed = (slide as { framedCount?: number }).framedCount;
  return Math.max(exp, framed ?? 0);
}

export function inspectCrossSlideMetricConsistency(input: {
  themeSet: OrionThemeSet | null;
  slides: OrionGoldenDeckSlide[];
}): MetricConsistencyIssue[] {
  const issues: MetricConsistencyIssue[] = [];
  const theme = input.themeSet;
  if (!theme) return issues;
  const statusOr = (
    metric: { status?: "MEASURED" | "NOT_COLLECTED" | "NOT_APPLICABLE" } | undefined,
    total: number
  ) => metric?.status ?? (total > 0 ? "MEASURED" : "NOT_COLLECTED");
  const observedOr = (metric: { observedCount?: number } | undefined, total: number) =>
    metric?.observedCount ?? total;

  const ruSuggestSlides = input.slides.filter(
    (s) => /suggest/i.test(s.slotId ?? s.slideKey ?? "") && /ru|россия/i.test(`${s.title} ${s.sectionKey}`)
  );
  const uaeSuggestSlides = input.slides.filter(
    (s) => /suggest|p28/i.test(s.slotId ?? s.slideKey ?? "") && /оаэ|uae/i.test(`${s.title} ${s.sectionKey}`)
  );
  const ruRelatedSlides = input.slides.filter((s) => /p20|p21|p22|related/i.test(s.slotId ?? s.slideKey ?? ""));
  const uaeRelatedSlides = input.slides.filter((s) => /p32|uae.*related/i.test(s.slotId ?? s.slideKey ?? ""));
  const ruImageSlides = input.slides.filter((s) => /p1[4-7]|image/i.test(s.slotId ?? "") && /ru|россия/i.test(s.title));
  const uaeImageSlides = input.slides.filter((s) => /p29|image/i.test(s.slotId ?? "") && /оаэ|uae/i.test(s.title));

  const ruSuggestShown = ruSuggestSlides.reduce((a, s) => a + countSuggestionRows(s), 0);
  if (ruSuggestShown > 0 && statusOr(theme.ru.suggestionsMetric, theme.ru.suggestionsTotal) === "NOT_COLLECTED") {
    issues.push({
      code: "SUGGEST_DATA_WITH_ZERO_KPI",
      detail: `RU suggestions shown=${ruSuggestShown} but KPI status=NOT_COLLECTED`,
      page: ruSuggestSlides[0]?.pageNumber,
    });
  }
  if (
    statusOr(theme.ru.suggestionsMetric, theme.ru.suggestionsTotal) === "MEASURED" &&
    observedOr(theme.ru.suggestionsMetric, theme.ru.suggestionsTotal) <= 0
  ) {
    issues.push({ code: "ASSET_METRIC_MISMATCH", detail: "RU suggestions MEASURED without denominator" });
  }

  const uaeSuggestShown = uaeSuggestSlides.reduce((a, s) => a + countSuggestionRows(s), 0);
  if (uaeSuggestShown > 0 && statusOr(theme.uae.suggestionsMetric, theme.uae.suggestionsTotal) === "NOT_COLLECTED") {
    issues.push({
      code: "SUGGEST_DATA_WITH_ZERO_KPI",
      detail: `UAE suggestions shown=${uaeSuggestShown} but KPI status=NOT_COLLECTED`,
      page: uaeSuggestSlides[0]?.pageNumber,
    });
  }
  if (
    statusOr(theme.uae.suggestionsMetric, theme.uae.suggestionsTotal) === "MEASURED" &&
    observedOr(theme.uae.suggestionsMetric, theme.uae.suggestionsTotal) <= 0
  ) {
    issues.push({ code: "ASSET_METRIC_MISMATCH", detail: "UAE suggestions MEASURED without denominator" });
  }

  const ruRelatedShown = ruRelatedSlides.reduce((a, s) => a + countRelatedRows(s), 0);
  if (ruRelatedShown > 0 && statusOr(theme.ru.relatedMetric, theme.ru.relatedTotal) === "NOT_COLLECTED") {
    issues.push({
      code: "RELATED_DATA_WITH_ZERO_KPI",
      detail: `RU related shown=${ruRelatedShown} but KPI status=NOT_COLLECTED`,
      page: ruRelatedSlides[0]?.pageNumber,
    });
  }
  if (
    statusOr(theme.ru.relatedMetric, theme.ru.relatedTotal) === "MEASURED" &&
    observedOr(theme.ru.relatedMetric, theme.ru.relatedTotal) <= 0
  ) {
    issues.push({ code: "ASSET_METRIC_MISMATCH", detail: "RU related MEASURED without denominator" });
  }

  const uaeRelatedShown = uaeRelatedSlides.reduce((a, s) => a + countRelatedRows(s), 0);
  if (uaeRelatedShown > 0 && statusOr(theme.uae.relatedMetric, theme.uae.relatedTotal) === "NOT_COLLECTED") {
    issues.push({
      code: "RELATED_DATA_WITH_ZERO_KPI",
      detail: `UAE related shown=${uaeRelatedShown} but KPI status=NOT_COLLECTED`,
      page: uaeRelatedSlides[0]?.pageNumber,
    });
  }
  if (
    statusOr(theme.uae.relatedMetric, theme.uae.relatedTotal) === "MEASURED" &&
    observedOr(theme.uae.relatedMetric, theme.uae.relatedTotal) <= 0
  ) {
    issues.push({ code: "ASSET_METRIC_MISMATCH", detail: "UAE related MEASURED without denominator" });
  }

  const ruImagesShown = ruImageSlides.reduce((a, s) => a + countImageHighlights(s), 0);
  if (statusOr(theme.ru.imagesMetric, theme.ru.imagesTotal) === "NOT_COLLECTED" && ruImagesShown > 0) {
    issues.push({
      code: "ASSET_METRIC_MISMATCH",
      detail: `RU images shown=${ruImagesShown} but KPI status=NOT_COLLECTED`,
      page: ruImageSlides[0]?.pageNumber,
    });
  }
  if (
    statusOr(theme.ru.imagesMetric, theme.ru.imagesTotal) === "MEASURED" &&
    observedOr(theme.ru.imagesMetric, theme.ru.imagesTotal) <= 0
  ) {
    issues.push({ code: "ASSET_METRIC_MISMATCH", detail: "RU images MEASURED without denominator" });
  }
  if (theme.ru.imagesAdverse > 0 && ruImagesShown < theme.ru.imagesAdverse) {
    issues.push({
      code: "IMAGE_EVIDENCE_COUNT_MISMATCH",
      detail: `RU imagesAdverse KPI=${theme.ru.imagesAdverse} but highlighted on slides=${ruImagesShown}`,
      page: ruImageSlides[0]?.pageNumber,
    });
  }

  const uaeImagesShown = uaeImageSlides.reduce((a, s) => a + countImageHighlights(s), 0);
  if (statusOr(theme.uae.imagesMetric, theme.uae.imagesTotal) === "NOT_COLLECTED" && uaeImagesShown > 0) {
    issues.push({
      code: "ASSET_METRIC_MISMATCH",
      detail: `UAE images shown=${uaeImagesShown} but KPI status=NOT_COLLECTED`,
      page: uaeImageSlides[0]?.pageNumber,
    });
  }
  if (
    statusOr(theme.uae.imagesMetric, theme.uae.imagesTotal) === "MEASURED" &&
    observedOr(theme.uae.imagesMetric, theme.uae.imagesTotal) <= 0
  ) {
    issues.push({ code: "ASSET_METRIC_MISMATCH", detail: "UAE images MEASURED without denominator" });
  }
  if (theme.uae.imagesAdverse > 0 && uaeImagesShown < theme.uae.imagesAdverse) {
    issues.push({
      code: "IMAGE_EVIDENCE_COUNT_MISMATCH",
      detail: `UAE imagesAdverse KPI=${theme.uae.imagesAdverse} but highlighted on slides=${uaeImagesShown}`,
      page: uaeImageSlides[0]?.pageNumber,
    });
  }

  for (const slide of input.slides) {
    const blob = slideTexts(slide);
    if (/\b0\s*\/\s*0\b/.test(blob) && !/данные\s+не\s+собран|не\s+применимо/i.test(blob)) {
      issues.push({
        code: "ASSET_METRIC_MISMATCH",
        detail: "0/0 without NOT_COLLECTED label",
        page: slide.pageNumber,
        slotId: slide.slotId,
      });
    }
  }

  return issues;
}
