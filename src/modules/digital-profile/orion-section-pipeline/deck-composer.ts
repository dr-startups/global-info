import type {
  OrionBlueprint,
  OrionCompositionInspection,
  OrionFinalDeckManifest,
  OrionManifestSlide,
  OrionMicroStage,
  OrionSectionDeckManifest,
  OrionSlideManifest,
} from "./types";

function sectionTocSlide(section: OrionSectionDeckManifest): OrionManifestSlide {
  return {
    slideId: `${section.macroSectionKey}-toc`,
    slideType: "section_toc_orion",
    title: section.titleRu,
    subtitle: "Содержание раздела",
    metrics: [],
    tables: [],
    cards: [],
    narrativeBlocks: [],
    screenshots: [],
    visuals: [],
    evidenceRefs: [],
    clientSafe: true,
    internalOnly: false,
  };
}

function coverSlide(): OrionManifestSlide {
  return {
    slideId: "cover-orion",
    slideType: "cover_orion",
    title: "Цифровой профиль",
    subtitle: "ORION Section Pipeline",
    metrics: [],
    tables: [],
    cards: [],
    narrativeBlocks: [],
    screenshots: [],
    visuals: [],
    evidenceRefs: [],
    clientSafe: true,
    internalOnly: false,
  };
}

function tocSlide(): OrionManifestSlide {
  return {
    slideId: "toc-orion",
    slideType: "toc_orion",
    title: "Содержание",
    subtitle: "Глобальная структура отчета",
    metrics: [],
    tables: [],
    cards: [],
    narrativeBlocks: [],
    screenshots: [],
    visuals: [],
    evidenceRefs: [],
    clientSafe: true,
    internalOnly: false,
  };
}

function blueprintOrderMap(blueprint: OrionBlueprint): Map<string, OrionMicroStage> {
  const map = new Map<string, OrionMicroStage>();
  for (const section of blueprint.macroSections) {
    for (const stage of section.microStages) {
      map.set(stage.microStageKey, stage);
    }
  }
  return map;
}

export function composeFinalDeckManifest(input: {
  runId: string;
  blueprint: OrionBlueprint;
  slideManifests: OrionSlideManifest[];
}): {
  finalManifest: OrionFinalDeckManifest;
  compositionInspection: OrionCompositionInspection;
  internalSlides: OrionManifestSlide[];
  clientSlides: OrionManifestSlide[];
} {
  const stageMap = blueprintOrderMap(input.blueprint);
  const manifestByStage = new Map(input.slideManifests.map((m) => [m.microStageKey, m]));
  const sections: OrionSectionDeckManifest[] = [];
  const missingMicroStages: string[] = [];
  const slideCountByMicroStage: Record<string, number> = {};
  const macroSectionStartPages: Record<string, number> = {};
  const microStageStartPages: Record<string, number> = {};
  const allMicroStages: string[] = [];

  const internalSlides: OrionManifestSlide[] = [coverSlide(), tocSlide()];
  const internalOnlySlides: string[] = [];

  for (const section of [...input.blueprint.macroSections].sort((a, b) => a.order - b.order)) {
    if (section.macroSectionKey === "cover" || section.macroSectionKey === "toc_global") continue;
    const sectionSlides: OrionManifestSlide[] = [];
    macroSectionStartPages[section.macroSectionKey] = internalSlides.length + 1;
    if (section.hasSectionToc) {
      sectionSlides.push(sectionTocSlide({
        macroSectionKey: section.macroSectionKey,
        sectionNumber: section.sectionNumber,
        titleRu: section.titleRu,
        order: section.order,
        slides: [],
      }));
    }

    for (const stage of [...section.microStages].sort((a, b) => a.order - b.order)) {
      allMicroStages.push(stage.microStageKey);
      const found = manifestByStage.get(stage.microStageKey);
      if (!found) {
        missingMicroStages.push(stage.microStageKey);
        slideCountByMicroStage[stage.microStageKey] = 0;
        continue;
      }
      microStageStartPages[stage.microStageKey] = internalSlides.length + sectionSlides.length + 1;
      slideCountByMicroStage[stage.microStageKey] = found.slides.length;
      sectionSlides.push(...found.slides);
    }

    sections.push({
      macroSectionKey: section.macroSectionKey,
      sectionNumber: section.sectionNumber,
      titleRu: section.titleRu,
      order: section.order,
      sectionStartPage: macroSectionStartPages[section.macroSectionKey],
      slides: sectionSlides,
    });

    internalSlides.push(...sectionSlides);
  }

  const tocEntries = sections.map((s) => ({
    title: `${s.sectionNumber ?? ""} ${s.titleRu}`.trim(),
    page: s.sectionStartPage ?? 0,
  }));

  const clientSlides = internalSlides.filter((slide) => !slide.internalOnly && slide.clientSafe);
  const clientRemovedSlides = internalSlides
    .filter((slide) => slide.internalOnly || !slide.clientSafe)
    .map((slide) => slide.slideId);
  for (const slide of internalSlides) {
    if (slide.internalOnly) internalOnlySlides.push(slide.slideId);
  }
  const lexisNexisVisualPageCount = internalSlides.filter((s) => s.slideType === "lexisnexis_visual_page").length;

  const finalManifest: OrionFinalDeckManifest = {
    runId: input.runId,
    mode: input.blueprint.mode,
    version: input.blueprint.version,
    generatedAt: new Date().toISOString(),
    tocEntries,
    sections,
    totalSlidesInternal: internalSlides.length,
    totalSlidesClient: clientSlides.length,
    lexisNexisVisualPageCount,
  };

  const compositionInspection: OrionCompositionInspection = {
    runId: input.runId,
    coverPage: 1,
    globalTocPage: 2,
    macroSections: [
      "cover",
      "toc_global",
      ...sections.map((x) => x.macroSectionKey),
    ],
    microStages: allMicroStages,
    missingMicroStages,
    slideCountByMicroStage,
    macroSectionStartPages,
    microStageStartPages,
    internalOnlySlides,
    clientRemovedSlides,
    internalPageCount: internalSlides.length,
    clientPageCount: clientSlides.length,
    finalInternalPageCount: internalSlides.length,
    finalClientPageCount: clientSlides.length,
    lexisNexisVisualPageCount,
    tocEntries,
    warnings: missingMicroStages.length > 0 ? ["missing-micro-stages-detected"] : [],
    errors: [],
  };

  // Ensure manifest ordering is deterministic by blueprint stage order.
  for (const section of finalManifest.sections) {
    section.slides.sort((a, b) => {
      const aStage = a.slideId.split("-")[0];
      const bStage = b.slideId.split("-")[0];
      const aOrder = stageMap.get(aStage)?.order ?? Number.MAX_SAFE_INTEGER;
      const bOrder = stageMap.get(bStage)?.order ?? Number.MAX_SAFE_INTEGER;
      return aOrder - bOrder;
    });
  }

  return { finalManifest, compositionInspection, internalSlides, clientSlides };
}

