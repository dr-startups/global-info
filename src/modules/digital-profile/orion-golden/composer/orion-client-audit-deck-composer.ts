/**
 * R10.9 — Client_audit deck composer from ReportSpec built via client-content adapter.
 * Omits commercial/product/about slides; skips expandToMinPages filler for empty sections.
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";
import { humanizeClientRiskMatrixRow } from "../client/risk-matrix-normalizer";
import type { OrionGoldenReportSpec, SectionBlock } from "../report-spec/orion-report-spec";
import type { OrionGoldenDeckManifest, OrionGoldenDeckSlide } from "../composer/orion-deck-composer";

function slidesFromBlock(sectionKey: string, block: SectionBlock): OrionGoldenDeckSlide[] {
  return (block.slideSpecs ?? []).map((spec) => ({
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

function sanitizeSlide(slide: OrionGoldenDeckSlide): OrionGoldenDeckSlide {
  return {
    ...slide,
    title: sanitizeOrionGoldenClientText(slide.title),
    narrative: slide.narrative ? sanitizeOrionGoldenClientText(slide.narrative) : undefined,
    bullets: slide.bullets?.map((b) => sanitizeOrionGoldenClientText(b)).filter(Boolean),
  };
}

function riskMatrixSlides(reportSpec: OrionGoldenReportSpec): OrionGoldenDeckSlide[] {
  const matrix = (reportSpec.riskMatrix ?? []).map((r) =>
    humanizeClientRiskMatrixRow({ theme: r.theme, level: r.level, summary: r.summary })
  );
  if (matrix.length === 0) {
    return [
      {
        slideKey: "risk-matrix-empty",
        sectionKey: "compliance_risk_matrix",
        template: "orion_golden_risk_matrix",
        title: "Матрица рисков compliance",
        pageNumber: 0,
        bullets: ["Существенных подтверждённых тем риска не выявлено на текущем этапе."],
      },
    ];
  }
  const slides: OrionGoldenDeckSlide[] = [];
  for (let i = 0; i < matrix.length; i += 6) {
    const chunk = matrix.slice(i, i + 6);
    slides.push({
      slideKey: `risk-matrix-${Math.floor(i / 6) + 1}`,
      sectionKey: "compliance_risk_matrix",
      template: "orion_golden_risk_matrix",
      title: "Матрица рисков compliance",
      pageNumber: 0,
      bullets: chunk.map((r) => `${r.theme} — ${r.level}`),
      narrative: chunk.map((r) => `${r.theme}: ${r.summary}`).join("\n"),
    });
  }
  return slides;
}

function includeBlock(block: SectionBlock): boolean {
  return (
    (block.slideSpecs?.length ?? 0) > 0 ||
    Boolean(block.narrative?.trim()) ||
    (block.evidenceCards?.length ?? 0) > 0
  );
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

/**
 * Compose a client_audit deck: content from adapter ReportSpec, no commercial filler.
 */
export function composeOrionClientAuditDeck(
  reportSpec: OrionGoldenReportSpec,
  assets: ReportAssetV1[] = []
): OrionGoldenDeckManifest {
  const serpAssets = assets.filter((a) => a.kind === "synthetic_serp" && a.status === "ready");
  const lexisAssets = assets.filter((a) => a.kind === "lexis_visual_page" && a.status === "ready");

  const sections: Array<{ sectionKey: string; slides: OrionGoldenDeckSlide[] }> = [
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
      slides: [
        {
          slideKey: "toc-1",
          sectionKey: "global_toc",
          template: "orion_golden_toc",
          title: "Содержание",
          pageNumber: 0,
          bullets: reportSpec.globalToc.slice(0, 16).map((t) => t.title),
        },
      ],
    },
    {
      sectionKey: "executive_summary",
      slides: [
        {
          slideKey: "executive-1",
          sectionKey: "executive_summary",
          template: "orion_golden_executive_card",
          title: "Резюме",
          pageNumber: 0,
          narrative: reportSpec.executiveSummary.executiveSummary,
          bullets: [
            ...reportSpec.executiveSummary.mainRisks.slice(0, 4),
            ...reportSpec.executiveSummary.finalRecommendations.slice(0, 3),
          ],
        },
      ],
    },
    {
      sectionKey: "compliance_risk_matrix",
      slides: riskMatrixSlides(reportSpec),
    },
  ];

  const contentBlocks: Array<{ sectionKey: string; block: SectionBlock }> = [
    { sectionKey: "ru_audit_summary", block: reportSpec.ruAuditSummary },
    { sectionKey: "ru_search_results", block: reportSpec.ruSearchResults },
    { sectionKey: "ru_wikipedia", block: reportSpec.ruWikipedia },
    { sectionKey: "uae_audit_summary", block: reportSpec.uaeAuditSummary },
    { sectionKey: "uae_search_results", block: reportSpec.uaeSearchResults },
    { sectionKey: "uae_wikipedia", block: reportSpec.uaeWikipedia },
    { sectionKey: "compliance_databases", block: reportSpec.complianceDatabases },
    { sectionKey: "lexisnexis", block: reportSpec.lexisNexis },
    { sectionKey: "dow_jones", block: reportSpec.dowJones },
    { sectionKey: "world_check", block: reportSpec.worldCheck },
  ];

  for (const { sectionKey, block } of contentBlocks) {
    if (!includeBlock(block)) continue;
    sections.push({ sectionKey, slides: slidesFromBlock(sectionKey, block) });
  }

  if (serpAssets.length > 0) {
    sections.push({
      sectionKey: "ru_serp_screenshots",
      slides: assetSlides(
        "ru_serp_screenshots",
        "orion_golden_serp_screenshot",
        "Снимок выдачи",
        serpAssets.slice(0, 4)
      ),
    });
  }

  if (lexisAssets.length > 0) {
    sections.push({
      sectionKey: "lexisnexis_visual",
      slides: assetSlides(
        "lexisnexis",
        "orion_golden_lexis_visual_page",
        "LexisNexis",
        lexisAssets.slice(0, 6)
      ),
    });
  }

  // Recommendations (stored in offer slot by adapter)
  if (includeBlock(reportSpec.offer) && reportSpec.offer.qaMetadata.sectionKey === "recommendations") {
    sections.push({
      sectionKey: "recommendations",
      slides: slidesFromBlock("recommendations", reportSpec.offer),
    });
  }

  // Manual review + appendix (adapter packs both into appendix)
  if (includeBlock(reportSpec.appendix)) {
    sections.push({
      sectionKey: "manual_review_required",
      slides: slidesFromBlock("manual_review_required", {
        ...reportSpec.appendix,
        slideSpecs: reportSpec.appendix.slideSpecs.filter((s) =>
          s.slideKey.startsWith("manual-review")
        ),
      }),
    });
    sections.push({
      sectionKey: "appendix",
      slides: slidesFromBlock("appendix", {
        ...reportSpec.appendix,
        slideSpecs: reportSpec.appendix.slideSpecs.filter(
          (s) => !s.slideKey.startsWith("manual-review")
        ),
      }),
    });
  }

  // Explicitly do NOT add: offer/product/solution/about commercial slides

  let page = 1;
  const sectionManifests: OrionGoldenDeckManifest["sectionManifests"] = [];
  const finalSlides: OrionGoldenDeckSlide[] = [];

  for (const section of sections) {
    const slides = section.slides.filter((s) => s.title || s.narrative || (s.bullets?.length ?? 0) > 0);
    if (slides.length === 0) continue;
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
