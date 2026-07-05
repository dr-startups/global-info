import type {
  OrionGpt55SectionAnalysis,
  OrionManifestSlide,
  OrionMicroStage,
  OrionSlideManifest,
} from "./types";
import {
  buildClientSubheadline,
  buildEvidenceExampleRows,
  buildNarrativeBlocksFromAnalysis,
  normalizeMetricCards,
  normalizeSlideTableRows,
  sanitizeClientSlide,
} from "./client-slide-contract";

function buildExampleTable(analysis: OrionGpt55SectionAnalysis) {
  const fromSlide = normalizeSlideTableRows(analysis.slideContent.tables);
  if (fromSlide.length > 0) return fromSlide;
  return buildEvidenceExampleRows(analysis);
}

function buildClientSlide(input: {
  microStage: OrionMicroStage;
  analysis: OrionGpt55SectionAnalysis;
  slideId: string;
  slideType: string;
  title?: string;
  subtitle?: string;
  visuals?: string[];
  narrativeBlocks?: Array<{ title: string; text: string }>;
}): OrionManifestSlide {
  const { microStage, analysis } = input;
  const metrics = normalizeMetricCards(analysis.slideContent.metricCards);
  const tables = buildExampleTable(analysis);
  const narrativeBlocks =
    input.narrativeBlocks ?? buildNarrativeBlocksFromAnalysis(analysis);

  const slide = sanitizeClientSlide({
    slideId: input.slideId,
    slideType: input.slideType,
    title: input.title ?? (analysis.slideContent.headline || microStage.titleRu),
    subtitle:
      input.subtitle ??
      buildClientSubheadline(analysis, microStage.titleRu),
    metrics,
    tables,
    cards: [],
    narrativeBlocks,
    screenshots: analysis.slideContent.screenshotRefs,
    visuals: input.visuals ?? analysis.slideContent.visualRefs,
    evidenceRefs: analysis.slideContent.evidenceRefs,
    clientSafe: true,
    internalOnly: false,
  });

  if (slide.metrics.length === 0 && slide.tables.length === 0 && slide.narrativeBlocks.length === 0) {
    slide.narrativeBlocks = [
      {
        title: "Статус раздела",
        text: "По этому разделу недостаточно структурированных данных для детализированной клиентской карточки; материалы сохранены во внутреннем evidence.",
      },
    ];
  }

  return slide;
}

export function buildMicroStageSlideManifest(input: {
  microStage: OrionMicroStage;
  analysis: OrionGpt55SectionAnalysis;
}): OrionSlideManifest {
  const { microStage, analysis } = input;
  const isLexisVisualStage = microStage.microStageKey === "lexisnexis_visual_pages";
  const hasLexisVisuals =
    analysis.slideContent.visualRefs.length > 0 ||
    analysis.slideContent.screenshotRefs.length > 0;
  const resolvedSlideType =
    isLexisVisualStage && !hasLexisVisuals
      ? "lexisnexis_unavailable_fallback"
      : microStage.slideTemplateKey;

  if (isLexisVisualStage && !hasLexisVisuals) {
    return {
      microStageKey: microStage.microStageKey,
      macroSectionKey: microStage.macroSectionKey,
      order: microStage.order,
      slides: [
        buildClientSlide({
          microStage,
          analysis,
          slideId: `${microStage.microStageKey}-01`,
          slideType: "lexisnexis_unavailable_fallback",
          title: analysis.slideContent.headline || microStage.titleRu,
          subtitle: "Визуальные страницы LexisNexis",
          narrativeBlocks: [
            {
              title: "Статус",
              text: "Визуальные страницы LexisNexis не сформированы; текстовая аналитика сохранена.",
            },
          ],
          visuals: [],
        }),
      ],
    };
  }

  const slides: OrionManifestSlide[] =
    isLexisVisualStage && hasLexisVisuals
      ? analysis.slideContent.visualRefs.map((ref, idx) =>
          buildClientSlide({
            microStage,
            analysis,
            slideId: `${microStage.microStageKey}-${String(idx + 1).padStart(2, "0")}`,
            slideType: "lexisnexis_visual_page",
            title: `${analysis.slideContent.headline || microStage.titleRu} — стр. ${idx + 1}`,
            subtitle: "Импортированная визуальная страница LexisNexis",
            visuals: [ref],
            narrativeBlocks:
              idx === 0
                ? buildNarrativeBlocksFromAnalysis(analysis).slice(0, 2)
                : [
                    {
                      title: "Комментарий",
                      text: "Страница импортирована из загруженного документа LexisNexis.",
                    },
                  ],
          })
        )
      : [
          buildClientSlide({
            microStage,
            analysis,
            slideId: `${microStage.microStageKey}-01`,
            slideType: resolvedSlideType,
          }),
        ];

  return {
    microStageKey: microStage.microStageKey,
    macroSectionKey: microStage.macroSectionKey,
    order: microStage.order,
    slides,
  };
}
