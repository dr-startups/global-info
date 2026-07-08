/**
 * R10 — ORION Golden reference blueprint (macro-structure from ORION PDF reference).
 */

import type { OrionGoldenSectionKey } from "../types";

export type OrionGoldenRendererTemplate =
  | "orion_golden_cover"
  | "orion_golden_toc"
  | "orion_golden_executive_card"
  | "orion_golden_risk_matrix"
  | "orion_golden_region_divider"
  | "orion_golden_audit_dashboard"
  | "orion_golden_search_overview"
  | "orion_golden_search_table"
  | "orion_golden_serp_screenshot"
  | "orion_golden_image_grid"
  | "orion_golden_video_cards"
  | "orion_golden_knowledge_panel"
  | "orion_golden_wikipedia"
  | "orion_golden_compliance_summary"
  | "orion_golden_lexis_summary"
  | "orion_golden_lexis_visual_page"
  | "orion_golden_offer"
  | "orion_golden_product_overview"
  | "orion_golden_solution"
  | "orion_golden_about"
  | "orion_golden_appendix"
  | "orion_golden_no_data_compact";

export interface OrionGoldenBlueprintSection {
  sectionKey: OrionGoldenSectionKey;
  title: string;
  order: number;
  expectedPageRange: { min: number; max: number };
  dataNeeds: string[];
  requiredAgents: string[];
  requiredAssets: string[];
  requiresGPTAnalysis: boolean;
  rendererTemplate: OrionGoldenRendererTemplate;
  qaChecks: string[];
  canBeGeneratedIndependently: boolean;
  dependencies: OrionGoldenSectionKey[];
}

export const ORION_GOLDEN_BLUEPRINT: {
  version: string;
  mode: string;
  targetPageRange: { min: number; max: number };
  sections: OrionGoldenBlueprintSection[];
} = {
  version: "r10-orion-golden-blueprint-v1",
  mode: "orion_golden_reference_v1",
  targetPageRange: { min: 60, max: 75 },
  sections: [
    sec("cover", "ORION Digital Profile", 1, { min: 1, max: 1 }, [], [], ["orion_golden_cover"], false, [], true, []),
    sec("global_toc", "Содержание отчёта", 2, { min: 1, max: 2 }, [], [], ["orion_golden_toc"], false, [], true, []),
    sec(
      "executive_summary",
      "Резюме",
      3,
      { min: 2, max: 4 },
      ["allSectionAnalyses", "riskFindings", "complianceSummary"],
      ["gptExecutiveSynthesisAgent"],
      ["orion_golden_executive_card"],
      true,
      ["executive-after-sections", "no-raw-ids"],
      false,
      [
        "ru_audit_summary",
        "uae_audit_summary",
        "compliance_databases",
        "lexisnexis",
      ]
    ),
    sec(
      "compliance_risk_matrix",
      "Compliance risk matrix",
      4,
      { min: 1, max: 2 },
      ["riskFindings", "complianceHits"],
      ["gptExecutiveSynthesisAgent"],
      ["orion_golden_risk_matrix"],
      true,
      ["risk-matrix-present"],
      false,
      ["executive_summary"]
    ),
    sec("ru_digital_profile", "Россия: Цифровой профиль", 5, { min: 1, max: 1 }, [], [], ["orion_golden_region_divider"], false, [], true, []),
    sec(
      "ru_audit_summary",
      "5.1 Резюме аудита",
      6,
      { min: 2, max: 3 },
      ["ruSearchResults", "ruRiskFindings", "ruSurfaces"],
      ["gptSectionAnalysisAgent", "sectionRouterAgent"],
      ["orion_golden_audit_dashboard"],
      true,
      ["ru-audit-readable"],
      true,
      []
    ),
    sec(
      "ru_search_results",
      "5.2 Результаты поиска",
      7,
      { min: 4, max: 8 },
      ["ruSearchResults", "ruSerpScreenshots"],
      ["gptSectionAnalysisAgent", "sectionRouterAgent"],
      ["orion_golden_search_overview", "orion_golden_search_table", "orion_golden_serp_screenshot"],
      true,
      ["serp-visible", "search-table-not-empty-or-no-data"],
      true,
      []
    ),
    sec(
      "ru_serp_screenshots",
      "Яндекс / Google — снимки выдачи",
      8,
      { min: 2, max: 4 },
      ["serpScreenshots"],
      ["screenshotCollector"],
      ["orion_golden_serp_screenshot"],
      false,
      ["serp-embedded"],
      true,
      []
    ),
    sec("ru_suggestions", "Подсказки поиска", 9, { min: 1, max: 2 }, ["ruSuggestions"], ["sectionRouterAgent"], ["orion_golden_search_table"], false, [], true, []),
    sec("ru_images", "Изображения", 10, { min: 1, max: 3 }, ["ruImages"], ["imageSearchCollector"], ["orion_golden_image_grid"], false, ["image-grid-if-data"], true, []),
    sec("ru_videos", "Видео", 11, { min: 1, max: 2 }, ["ruVideos"], ["videoSearchCollector"], ["orion_golden_video_cards"], false, [], true, []),
    sec("ru_knowledge", "Knowledge panel", 12, { min: 1, max: 2 }, ["ruKnowledge"], ["knowledgePanelCollector"], ["orion_golden_knowledge_panel"], false, [], true, []),
    sec(
      "ru_wikipedia",
      "5.3 Википедия",
      13,
      { min: 1, max: 2 },
      ["wikiChecks"],
      ["gptSectionAnalysisAgent", "wikipediaCollector"],
      ["orion_golden_wikipedia"],
      true,
      ["wiki-section"],
      true,
      []
    ),
    sec("uae_digital_profile", "ОАЭ: Цифровой профиль", 14, { min: 1, max: 1 }, [], [], ["orion_golden_region_divider"], false, [], true, []),
    sec(
      "uae_audit_summary",
      "6.1 Резюме аудита",
      15,
      { min: 2, max: 3 },
      ["uaeSearchResults", "uaeRiskFindings"],
      ["gptSectionAnalysisAgent"],
      ["orion_golden_audit_dashboard"],
      true,
      [],
      true,
      []
    ),
    sec(
      "uae_search_results",
      "6.2 Результаты поиска",
      16,
      { min: 3, max: 6 },
      ["uaeSearchResults"],
      ["gptSectionAnalysisAgent"],
      ["orion_golden_search_overview", "orion_golden_search_table"],
      true,
      [],
      true,
      []
    ),
    sec("uae_serp_screenshots", "ОАЭ — снимки выдачи", 17, { min: 1, max: 2 }, ["uaeSerp"], ["screenshotCollector"], ["orion_golden_serp_screenshot"], false, [], true, []),
    sec("uae_suggestions", "ОАЭ — подсказки", 18, { min: 1, max: 1 }, ["uaeSuggestions"], ["sectionRouterAgent"], ["orion_golden_search_table"], false, [], true, []),
    sec("uae_images", "ОАЭ — изображения", 19, { min: 1, max: 2 }, ["uaeImages"], ["imageSearchCollector"], ["orion_golden_image_grid"], false, [], true, []),
    sec("uae_videos", "ОАЭ — видео", 20, { min: 1, max: 1 }, ["uaeVideos"], ["videoSearchCollector"], ["orion_golden_video_cards"], false, [], true, []),
    sec("uae_knowledge", "ОАЭ — knowledge panel", 21, { min: 1, max: 1 }, ["uaeKnowledge"], ["knowledgePanelCollector"], ["orion_golden_knowledge_panel"], false, [], true, []),
    sec(
      "uae_wikipedia",
      "6.3 Википедия",
      22,
      { min: 1, max: 2 },
      ["wikiChecks"],
      ["gptSectionAnalysisAgent"],
      ["orion_golden_wikipedia"],
      true,
      [],
      true,
      []
    ),
    sec(
      "compliance_databases",
      "Dow Jones, World-Check, LexisNexis — обзор",
      23,
      { min: 2, max: 4 },
      ["databaseProfiles", "complianceHits"],
      ["gptSectionAnalysisAgent", "dowJonesWorldCheckImportCollector"],
      ["orion_golden_compliance_summary"],
      true,
      ["compliance-preliminary-framing"],
      true,
      []
    ),
    sec(
      "lexisnexis",
      "LexisNexis",
      24,
      { min: 3, max: 10 },
      ["lexisParsed", "lexisVisualPages"],
      ["gptSectionAnalysisAgent", "lexisNexisImportCollector"],
      ["orion_golden_lexis_summary", "orion_golden_lexis_visual_page"],
      true,
      ["lexis-summary-before-appendix"],
      true,
      []
    ),
    sec("dow_jones", "Dow Jones", 25, { min: 1, max: 2 }, ["dowJonesProfiles"], ["dowJonesWorldCheckImportCollector"], ["orion_golden_compliance_summary"], true, [], true, ["compliance_databases"]),
    sec("world_check", "World-Check", 26, { min: 1, max: 2 }, ["worldCheckProfiles"], ["dowJonesWorldCheckImportCollector"], ["orion_golden_compliance_summary"], true, [], true, ["compliance_databases"]),
    sec("offer", "Наше предложение", 27, { min: 2, max: 4 }, ["offerStatic"], ["reportSpecBuilderAgent"], ["orion_golden_offer"], false, [], true, []),
    sec("product_overview", "Цифровой профиль: обзор продукта", 28, { min: 2, max: 3 }, ["productStatic"], [], ["orion_golden_product_overview"], false, [], true, []),
    sec("solution_digital_profile", "Решение 1: Цифровой профиль", 29, { min: 2, max: 3 }, ["solutionStatic"], [], ["orion_golden_solution"], false, [], true, []),
    sec("solution_compliance_databases", "Решение 2: World-Check, LexisNexis и Dow Jones", 30, { min: 2, max: 3 }, ["solutionStatic"], [], ["orion_golden_solution"], false, [], true, []),
    sec("solution_wikipedia", "Решение 3: Википедия", 31, { min: 1, max: 2 }, ["solutionStatic"], [], ["orion_golden_solution"], false, [], true, []),
    sec("about", "О нас", 32, { min: 1, max: 2 }, ["aboutStatic"], [], ["orion_golden_about"], false, [], true, []),
    sec(
      "appendix",
      "Приложение",
      33,
      { min: 2, max: 6 },
      ["excludedEvidence", "sourceAppendix"],
      ["sectionRouterAgent"],
      ["orion_golden_appendix"],
      false,
      ["excluded-counted"],
      true,
      []
    ),
  ],
};

function sec(
  sectionKey: OrionGoldenSectionKey,
  title: string,
  order: number,
  expectedPageRange: { min: number; max: number },
  dataNeeds: string[],
  requiredAgents: string[],
  requiredAssets: string[],
  requiresGPTAnalysis: boolean,
  qaChecks: string[],
  canBeGeneratedIndependently: boolean,
  dependencies: OrionGoldenSectionKey[]
): OrionGoldenBlueprintSection {
  return {
    sectionKey,
    title,
    order,
    expectedPageRange,
    dataNeeds,
    requiredAgents,
    requiredAssets,
    requiresGPTAnalysis,
    rendererTemplate: (requiredAssets[0] ?? "orion_golden_no_data_compact") as OrionGoldenRendererTemplate,
    qaChecks,
    canBeGeneratedIndependently,
    dependencies,
  };
}

export function getGoldenBlueprintSection(key: OrionGoldenSectionKey): OrionGoldenBlueprintSection | undefined {
  return ORION_GOLDEN_BLUEPRINT.sections.find((s) => s.sectionKey === key);
}

export function getBodyGptSections(): OrionGoldenBlueprintSection[] {
  return ORION_GOLDEN_BLUEPRINT.sections.filter(
    (s) =>
      s.requiresGPTAnalysis &&
      s.sectionKey !== "executive_summary" &&
      s.sectionKey !== "compliance_risk_matrix"
  );
}

export function getExecutiveDependentSections(): OrionGoldenBlueprintSection[] {
  return ORION_GOLDEN_BLUEPRINT.sections.filter(
    (s) => s.sectionKey === "executive_summary" || s.sectionKey === "compliance_risk_matrix"
  );
}
