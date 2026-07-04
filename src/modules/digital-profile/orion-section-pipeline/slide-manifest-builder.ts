import type {
  OrionGpt55SectionAnalysis,
  OrionManifestSlide,
  OrionMicroStage,
  OrionSlideManifest,
} from "./types";

export function buildMicroStageSlideManifest(input: {
  microStage: OrionMicroStage;
  analysis: OrionGpt55SectionAnalysis;
}): OrionSlideManifest {
  const { microStage, analysis } = input;
  const isLexisVisualStage = microStage.microStageKey === "lexisnexis_visual_pages";
  const hasLexisVisuals = analysis.slideContent.visualRefs.length > 0 || analysis.slideContent.screenshotRefs.length > 0;
  const resolvedSlideType =
    isLexisVisualStage && !hasLexisVisuals
      ? "lexisnexis_unavailable_fallback"
      : microStage.slideTemplateKey;
  const slide: OrionManifestSlide = {
    slideId: `${microStage.microStageKey}-01`,
    slideType: resolvedSlideType,
    title: analysis.slideContent.headline || microStage.titleRu,
    subtitle: analysis.slideContent.subheadline || undefined,
    metrics: analysis.slideContent.metricCards,
    tables: analysis.slideContent.tables,
    cards: [],
    narrativeBlocks: analysis.slideContent.narrativeBlocks,
    screenshots: analysis.slideContent.screenshotRefs,
    visuals: analysis.slideContent.visualRefs,
    evidenceRefs: analysis.slideContent.evidenceRefs,
    clientSafe: true,
    internalOnly: false,
  };

  return {
    microStageKey: microStage.microStageKey,
    macroSectionKey: microStage.macroSectionKey,
    order: microStage.order,
    slides: [slide],
  };
}

