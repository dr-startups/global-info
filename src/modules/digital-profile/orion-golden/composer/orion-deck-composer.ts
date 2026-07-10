/**
 * R10 — ORION Golden deck composer (section parts → final manifest).
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import { ORION_GOLDEN_BLUEPRINT } from "../blueprint/orion-golden-blueprint";
import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";
import { humanizeClientRiskMatrixRow } from "../client/risk-matrix-normalizer";
import type { OrionGoldenReportSpec, SectionBlock } from "../report-spec/orion-report-spec";

export type VisualSlideAnalysis = {
  assetRef: string;
  headlineConclusion: string;
  whatIsVisible: string;
  metrics: Array<{ label: string; value: string }>;
  whyItMatters: string;
  recommendedActions: string[];
  confidence: "high" | "medium" | "low";
  limitations: string[];
  provenanceLabel?: string;
};

export type OrionGoldenDeckSlide = {
  slideKey: string;
  sectionKey: string;
  template: string;
  title: string;
  pageNumber: number;
  bullets?: string[];
  narrative?: string;
  assetRefs?: string[];
  /** Short client takeaway shown above/ beside visual. */
  clientTakeaway?: string;
  /** Analytical sidebar for screenshot / media pages. */
  visualAnalysis?: VisualSlideAnalysis;
  /** Honest blocked reason when required visual is missing. */
  blockedReason?: string;
  /** Structured search/position table (orion_golden_search_table). */
  table?: { headers: string[]; rows: string[][] };
};

export type OrionGoldenDeckManifest = {
  version: "r10-orion-golden-deck-manifest-v1";
  slideCount: number;
  sectionManifests: Array<{ sectionKey: string; slideCount: number; slides: OrionGoldenDeckSlide[] }>;
  finalSlides: OrionGoldenDeckSlide[];
  toc: Array<{ title: string; pageNumber: number }>;
  pageNumberMap: Record<string, number>;
};

function slidesFromBlock(sectionKey: string, block: SectionBlock): OrionGoldenDeckSlide[] {
  return block.slideSpecs.map((spec) => ({
    slideKey: spec.slideKey,
    sectionKey,
    template: spec.template,
    title: spec.title,
    pageNumber: 0,
    bullets: spec.bullets,
    narrative: block.narrative,
    assetRefs: block.visualAssets,
  }));
}

function expandToMinPages(sectionKey: string, block: SectionBlock, slides: OrionGoldenDeckSlide[]): OrionGoldenDeckSlide[] {
  const blueprint = ORION_GOLDEN_BLUEPRINT.sections.find((s) => s.sectionKey === sectionKey);
  const minPages = blueprint?.expectedPageRange.min ?? 1;
  if (slides.length >= minPages) return slides;

  const out = [...slides];
  for (let i = slides.length; i < minPages; i += 1) {
    const card = block.evidenceCards[i - slides.length];
    out.push({
      slideKey: `${sectionKey}-detail-${i + 1}`,
      sectionKey,
      template: "orion_golden_search_table",
      title: card?.title ?? block.sectionTitle,
      pageNumber: 0,
      bullets: card ? [card.summary].filter(Boolean) : [block.narrative.slice(0, 200)],
    });
  }
  return out;
}

function assetSlides(
  sectionKey: string,
  template: string,
  titlePrefix: string,
  assets: ReportAssetV1[]
): OrionGoldenDeckSlide[] {
  return assets.map((asset, idx) => ({
    slideKey: `${sectionKey}-${asset.assetRef}`,
    sectionKey,
    template,
    title: asset.title || `${titlePrefix} ${idx + 1}`,
    pageNumber: 0,
    bullets: asset.caption ? [asset.caption] : undefined,
    assetRefs: [asset.assetRef],
  }));
}

function chunkAssetSlides(
  sectionKey: string,
  template: string,
  title: string,
  assets: ReportAssetV1[],
  perSlide: number
): OrionGoldenDeckSlide[] {
  const slides: OrionGoldenDeckSlide[] = [];
  for (let i = 0; i < assets.length; i += perSlide) {
    const chunk = assets.slice(i, i + perSlide);
    slides.push({
      slideKey: `${sectionKey}-grid-${Math.floor(i / perSlide) + 1}`,
      sectionKey,
      template,
      title: `${title} (${Math.floor(i / perSlide) + 1})`,
      pageNumber: 0,
      assetRefs: chunk.map((a) => a.assetRef),
    });
  }
  return slides;
}

function sectionToBlock(title: string, narrative: string, template: string): SectionBlock {
  return {
    sectionTitle: title,
    metrics: {},
    narrative,
    tables: [],
    evidenceCards: [],
    visualAssets: [],
    slideSpecs: [{ slideKey: `${template}-1`, template, title }],
    sourceRefs: [],
    qaMetadata: { sectionKey: template },
  };
}

function sanitizeSlide(slide: OrionGoldenDeckSlide): OrionGoldenDeckSlide {
  return {
    ...slide,
    title: sanitizeOrionGoldenClientText(slide.title),
    narrative: slide.narrative ? sanitizeOrionGoldenClientText(slide.narrative) : undefined,
    bullets: slide.bullets?.map((b) => sanitizeOrionGoldenClientText(b)).filter(Boolean),
  };
}

function riskMatrixBlock(reportSpec: OrionGoldenReportSpec): SectionBlock {
  const matrix = (reportSpec.riskMatrix ?? []).map((r) =>
    humanizeClientRiskMatrixRow({ theme: r.theme, level: r.level, summary: r.summary })
  );
  return {
    sectionTitle: "Compliance risk matrix",
    metrics: { themes: matrix.length },
    narrative: matrix.map((r) => `${r.theme}: ${r.summary}`).join("\n"),
    tables: [],
    evidenceCards: matrix.map((r) => ({ title: r.theme, summary: r.summary })),
    visualAssets: [],
    slideSpecs: [
      {
        slideKey: "risk-matrix-1",
        template: "orion_golden_risk_matrix",
        title: "Матрица рисков compliance",
        bullets: matrix.slice(0, 6).map((r) => `${r.theme} — ${r.level}`),
      },
    ],
    sourceRefs: [],
    qaMetadata: { sectionKey: "compliance_risk_matrix" },
  };
}

export function composeOrionGoldenDeck(
  reportSpec: OrionGoldenReportSpec,
  assets: ReportAssetV1[] = []
): OrionGoldenDeckManifest {
  const serpAssets = assets.filter((a) => a.kind === "synthetic_serp" && a.status === "ready");
  const lexisAssets = assets.filter((a) => a.kind === "lexis_visual_page" && a.status === "ready");
  const imageAssets = assets.filter((a) => a.kind === "image_grid");
  const videoAssets = assets.filter((a) => a.kind === "video_cards");
  const ruImages = imageAssets.slice(0, 18);
  const uaeImages = imageAssets.slice(18, 30);
  const ruVideos = videoAssets.slice(0, 8);
  const uaeVideos = videoAssets.slice(8, 12);

  type SectionDef = { sectionKey: string; slides: OrionGoldenDeckSlide[] };

  const sections: SectionDef[] = [
    {
      sectionKey: "cover",
      slides: [
        {
          slideKey: "cover",
          sectionKey: "cover",
          template: "orion_golden_cover",
          title: reportSpec.subject.reportTitle,
          pageNumber: 0,
          narrative: reportSpec.subject.displayName,
        },
      ],
    },
    {
      sectionKey: "global_toc",
      slides: expandToMinPages("global_toc", sectionToBlock("Содержание", "", "orion_golden_toc"), slidesFromBlock("global_toc", sectionToBlock("Содержание", "Оглавление", "orion_golden_toc"))),
    },
    {
      sectionKey: "executive_summary",
      slides: expandToMinPages(
        "executive_summary",
        sectionToBlock("Резюме", reportSpec.executiveSummary.executiveSummary, "orion_golden_executive_card"),
        slidesFromBlock(
          "executive_summary",
          sectionToBlock("Резюме", reportSpec.executiveSummary.executiveSummary, "orion_golden_executive_card")
        )
      ),
    },
    {
      sectionKey: "compliance_risk_matrix",
      slides: expandToMinPages("compliance_risk_matrix", riskMatrixBlock(reportSpec), slidesFromBlock("compliance_risk_matrix", riskMatrixBlock(reportSpec))),
    },
    { sectionKey: "ru_digital_profile", slides: slidesFromBlock("ru_digital_profile", sectionToBlock("Россия: Цифровой профиль", "", "orion_golden_region_divider")) },
    { sectionKey: "ru_audit_summary", slides: expandToMinPages("ru_audit_summary", reportSpec.ruAuditSummary, slidesFromBlock("ru_audit_summary", reportSpec.ruAuditSummary)) },
    { sectionKey: "ru_search_results", slides: expandToMinPages("ru_search_results", reportSpec.ruSearchResults, slidesFromBlock("ru_search_results", reportSpec.ruSearchResults)) },
    {
      sectionKey: "ru_serp_screenshots",
      slides:
        serpAssets.length > 0
          ? assetSlides("ru_serp_screenshots", "orion_golden_serp_screenshot", "Снимок выдачи", serpAssets.slice(0, 4))
          : expandToMinPages("ru_serp_screenshots", sectionToBlock("Снимки выдачи", "Снимки недоступны", "orion_golden_no_data_compact"), []),
    },
    {
      sectionKey: "ru_images",
      slides:
        ruImages.length > 0
          ? chunkAssetSlides("ru_images", "orion_golden_image_grid", "Изображения", ruImages, 6)
          : [],
    },
    {
      sectionKey: "ru_videos",
      slides: ruVideos.length > 0 ? chunkAssetSlides("ru_videos", "orion_golden_video_cards", "Видео", ruVideos, 4) : [],
    },
    { sectionKey: "ru_wikipedia", slides: expandToMinPages("ru_wikipedia", reportSpec.ruWikipedia, slidesFromBlock("ru_wikipedia", reportSpec.ruWikipedia)) },
    { sectionKey: "uae_digital_profile", slides: slidesFromBlock("uae_digital_profile", sectionToBlock("ОАЭ: Цифровой профиль", "", "orion_golden_region_divider")) },
    { sectionKey: "uae_audit_summary", slides: expandToMinPages("uae_audit_summary", reportSpec.uaeAuditSummary, slidesFromBlock("uae_audit_summary", reportSpec.uaeAuditSummary)) },
    { sectionKey: "uae_search_results", slides: expandToMinPages("uae_search_results", reportSpec.uaeSearchResults, slidesFromBlock("uae_search_results", reportSpec.uaeSearchResults)) },
    {
      sectionKey: "uae_serp_screenshots",
      slides:
        serpAssets.length > 4
          ? assetSlides("uae_serp_screenshots", "orion_golden_serp_screenshot", "Снимок выдачи", serpAssets.slice(4, 6))
          : [],
    },
    {
      sectionKey: "uae_images",
      slides: uaeImages.length > 0 ? chunkAssetSlides("uae_images", "orion_golden_image_grid", "Изображения", uaeImages, 6) : [],
    },
    {
      sectionKey: "uae_videos",
      slides: uaeVideos.length > 0 ? chunkAssetSlides("uae_videos", "orion_golden_video_cards", "Видео", uaeVideos, 4) : [],
    },
    { sectionKey: "uae_wikipedia", slides: expandToMinPages("uae_wikipedia", reportSpec.uaeWikipedia, slidesFromBlock("uae_wikipedia", reportSpec.uaeWikipedia)) },
    { sectionKey: "compliance_databases", slides: expandToMinPages("compliance_databases", reportSpec.complianceDatabases, slidesFromBlock("compliance_databases", reportSpec.complianceDatabases)) },
    {
      sectionKey: "lexisnexis",
      slides: [
        ...expandToMinPages("lexisnexis", reportSpec.lexisNexis, slidesFromBlock("lexisnexis", reportSpec.lexisNexis)),
        ...assetSlides("lexisnexis", "orion_golden_lexis_visual_page", "LexisNexis", lexisAssets),
      ],
    },
    { sectionKey: "dow_jones", slides: expandToMinPages("dow_jones", reportSpec.dowJones, slidesFromBlock("dow_jones", reportSpec.dowJones)) },
    { sectionKey: "world_check", slides: expandToMinPages("world_check", reportSpec.worldCheck, slidesFromBlock("world_check", reportSpec.worldCheck)) },
    { sectionKey: "offer", slides: expandToMinPages("offer", reportSpec.offer, slidesFromBlock("offer", reportSpec.offer)) },
    { sectionKey: "product_overview", slides: expandToMinPages("product_overview", reportSpec.productOverview, slidesFromBlock("product_overview", reportSpec.productOverview)) },
    { sectionKey: "solution_digital_profile", slides: expandToMinPages("solution_digital_profile", reportSpec.solutionDigitalProfile, slidesFromBlock("solution_digital_profile", reportSpec.solutionDigitalProfile)) },
    { sectionKey: "solution_compliance_databases", slides: expandToMinPages("solution_compliance_databases", reportSpec.solutionComplianceDatabases, slidesFromBlock("solution_compliance_databases", reportSpec.solutionComplianceDatabases)) },
    { sectionKey: "solution_wikipedia", slides: expandToMinPages("solution_wikipedia", reportSpec.solutionWikipedia, slidesFromBlock("solution_wikipedia", reportSpec.solutionWikipedia)) },
    { sectionKey: "about", slides: expandToMinPages("about", reportSpec.about, slidesFromBlock("about", reportSpec.about)) },
    { sectionKey: "appendix", slides: expandToMinPages("appendix", reportSpec.appendix, slidesFromBlock("appendix", reportSpec.appendix)) },
  ];

  let page = 1;
  const sectionManifests: OrionGoldenDeckManifest["sectionManifests"] = [];
  const finalSlides: OrionGoldenDeckSlide[] = [];

  for (const section of sections) {
    let slides = section.slides;
    if (slides.length === 0) {
      const bp = ORION_GOLDEN_BLUEPRINT.sections.find((s) => s.sectionKey === section.sectionKey);
      if (bp && bp.expectedPageRange.min > 0) {
        slides = expandToMinPages(
          section.sectionKey,
          sectionToBlock(bp.title, "Данные для раздела отсутствуют", "orion_golden_no_data_compact"),
          []
        );
      }
    }
    for (const s of slides) s.pageNumber = page++;
    sectionManifests.push({ sectionKey: section.sectionKey, slideCount: slides.length, slides });
    finalSlides.push(...slides.map(sanitizeSlide));
  }

  const toc = finalSlides
    .filter((s) => s.sectionKey !== "cover")
    .filter((_, idx, arr) => idx === 0 || arr[idx - 1]?.sectionKey !== arr[idx].sectionKey)
    .slice(0, 30)
    .map((s) => ({ title: s.title, pageNumber: s.pageNumber }));

  const pageNumberMap: Record<string, number> = {};
  for (const s of finalSlides) pageNumberMap[s.slideKey] = s.pageNumber;

  return {
    version: "r10-orion-golden-deck-manifest-v1",
    slideCount: finalSlides.length,
    sectionManifests,
    finalSlides,
    toc,
    pageNumberMap,
  };
}
