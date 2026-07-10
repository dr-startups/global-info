/**
 * Fixed First36 CEO storyboard — ORION reference slots 1–36 (audit only).
 * Composer fills each slot from classic reportSpec/assets or an honest blocked/status slide.
 */

export type First36Region = "GLOBAL" | "RU" | "UAE" | "COMPLIANCE";

export type First36SlotKind =
  | "cover"
  | "toc"
  | "executive"
  | "dashboard"
  | "region_toc"
  | "summary"
  | "metrics"
  | "search_table"
  | "serp_visual"
  | "suggestions_visual"
  | "wikipedia"
  | "image_visual"
  | "knowledge_visual"
  | "related_visual"
  | "compliance_toc"
  | "db_visual"
  | "db_status";

export type First36SlotDef = {
  page: number;
  slotId: string;
  sectionKey: string;
  kind: First36SlotKind;
  template: string;
  title: string;
  region: First36Region;
  /** If true, missing visual bytes → blocked slide (still occupies the page). */
  requiredVisual: boolean;
  match: {
    sectionKeys?: string[];
    templates?: string[];
    assetRefRe?: RegExp;
  };
};

export const ORION_FIRST36_REGISTRY_V1: First36SlotDef[] = [
  {
    page: 1,
    slotId: "p01_cover",
    sectionKey: "cover",
    kind: "cover",
    template: "orion_golden_cover",
    title: "ORION Digital Profile",
    region: "GLOBAL",
    requiredVisual: false,
    match: { sectionKeys: ["cover"], templates: ["orion_golden_cover"] },
  },
  {
    page: 2,
    slotId: "p02_toc",
    sectionKey: "global_toc",
    kind: "toc",
    template: "orion_golden_toc",
    title: "Содержание",
    region: "GLOBAL",
    requiredVisual: false,
    match: { sectionKeys: ["global_toc"], templates: ["orion_golden_toc"] },
  },
  {
    page: 3,
    slotId: "p03_executive",
    sectionKey: "01_executive_summary",
    kind: "executive",
    template: "orion_golden_executive_card",
    title: "Резюме",
    region: "GLOBAL",
    requiredVisual: false,
    match: { sectionKeys: ["01_executive_summary"], templates: ["orion_golden_executive_card"] },
  },
  {
    page: 4,
    slotId: "p04_risk_dashboard",
    sectionKey: "02_compliance_risk_matrix",
    kind: "dashboard",
    template: "orion_golden_risk_matrix",
    title: "Матрица рисков",
    region: "GLOBAL",
    requiredVisual: false,
    match: {
      sectionKeys: ["02_compliance_risk_matrix", "risk_matrix"],
      templates: ["orion_golden_risk_matrix"],
    },
  },
  {
    page: 5,
    slotId: "p05_profile_dashboard",
    sectionKey: "03_digital_profile_overview",
    kind: "dashboard",
    template: "orion_golden_executive_card",
    title: "Обзор цифрового профиля",
    region: "GLOBAL",
    requiredVisual: false,
    match: {
      sectionKeys: ["03_digital_profile_overview", "ru_digital_profile"],
      templates: ["orion_golden_executive_card", "orion_golden_prose"],
    },
  },
  {
    page: 6,
    slotId: "p06_ru_toc",
    sectionKey: "ru_digital_profile",
    kind: "region_toc",
    template: "orion_golden_region_divider",
    title: "Россия — цифровой профиль",
    region: "RU",
    requiredVisual: false,
    match: { sectionKeys: ["ru_digital_profile"], templates: ["orion_golden_region_divider"] },
  },
  {
    page: 7,
    slotId: "p07_ru_summary",
    sectionKey: "10_ru_audit_summary",
    kind: "summary",
    template: "orion_golden_prose",
    title: "Россия — резюме аудита",
    region: "RU",
    requiredVisual: false,
    match: { sectionKeys: ["10_ru_audit_summary"] },
  },
  {
    page: 8,
    slotId: "p08_ru_metrics",
    sectionKey: "11_ru_search_links",
    kind: "metrics",
    template: "orion_golden_prose",
    title: "Россия — показатели поиска",
    region: "RU",
    requiredVisual: false,
    match: { sectionKeys: ["11_ru_search_links", "ru_search_results"] },
  },
  {
    page: 9,
    slotId: "p09_ru_serp_table",
    sectionKey: "12_ru_serp_position_table",
    kind: "search_table",
    template: "orion_golden_search_table",
    title: "Россия — позиции в SERP",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["12_ru_serp_position_table"],
      templates: ["orion_golden_search_table"],
    },
  },
  {
    page: 10,
    slotId: "p10_ru_serp_visual",
    sectionKey: "ru_serp_screenshots",
    kind: "serp_visual",
    template: "orion_golden_serp_screenshot",
    title: "Россия — снимок выдачи",
    region: "RU",
    requiredVisual: true,
    match: {
      sectionKeys: ["ru_serp_screenshots"],
      templates: ["orion_golden_serp_screenshot"],
      assetRefRe: /^(?:ru_).*(?:serp|synserp)/i,
    },
  },
  {
    page: 11,
    slotId: "p11_ru_suggestions_yandex",
    sectionKey: "14_ru_suggestions",
    kind: "suggestions_visual",
    template: "orion_golden_surface_panel",
    title: "Россия — подсказки поиска",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["14_ru_suggestions"],
      templates: ["orion_golden_surface_panel", "orion_golden_prose"],
      assetRefRe: /ru_.*suggest.*yandex|ru_suggestions_yandex|ru_suggestions_saved/i,
    },
  },
  {
    page: 12,
    slotId: "p12_ru_suggestions_google",
    sectionKey: "14_ru_suggestions",
    kind: "suggestions_visual",
    template: "orion_golden_surface_panel",
    title: "Россия — подсказки Google",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["14_ru_suggestions"],
      templates: ["orion_golden_surface_panel", "orion_golden_prose"],
      assetRefRe: /ru_.*suggest.*google|ru_suggestions_google/i,
    },
  },
  {
    page: 13,
    slotId: "p13_ru_wikipedia",
    sectionKey: "16_ru_wikipedia",
    kind: "wikipedia",
    template: "orion_golden_prose",
    title: "Россия — Википедия",
    region: "RU",
    requiredVisual: false,
    match: { sectionKeys: ["16_ru_wikipedia", "ru_wikipedia"] },
  },
  {
    page: 14,
    slotId: "p14_ru_images_1",
    sectionKey: "ru_images",
    kind: "image_visual",
    template: "orion_golden_image_grid",
    title: "Россия — изображения (1)",
    region: "RU",
    requiredVisual: true,
    match: {
      sectionKeys: ["ru_images"],
      templates: ["orion_golden_image_grid"],
      assetRefRe: /^(?:ru)_image_grid(_1)?$/i,
    },
  },
  {
    page: 15,
    slotId: "p15_ru_images_2",
    sectionKey: "ru_images",
    kind: "image_visual",
    template: "orion_golden_image_grid",
    title: "Россия — изображения (2)",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["ru_images"],
      templates: ["orion_golden_image_grid"],
      assetRefRe: /^(?:ru)_image_grid_2$/i,
    },
  },
  {
    page: 16,
    slotId: "p16_ru_images_3",
    sectionKey: "ru_images",
    kind: "image_visual",
    template: "orion_golden_image_grid",
    title: "Россия — изображения (3)",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["ru_images"],
      templates: ["orion_golden_image_grid"],
      assetRefRe: /^(?:ru)_image_grid_3$/i,
    },
  },
  {
    page: 17,
    slotId: "p17_ru_images_4",
    sectionKey: "ru_images",
    kind: "image_visual",
    template: "orion_golden_image_grid",
    title: "Россия — изображения (4)",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["ru_images"],
      templates: ["orion_golden_image_grid"],
      assetRefRe: /^(?:ru)_image_grid_4$/i,
    },
  },
  {
    page: 18,
    slotId: "p18_ru_knowledge_1",
    sectionKey: "ru_knowledge",
    kind: "knowledge_visual",
    template: "orion_golden_knowledge_panel",
    title: "Россия — панель знаний (1)",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["ru_knowledge"],
      templates: ["orion_golden_knowledge_panel"],
      assetRefRe: /^(?:ru)_knowledge_panel(_1)?$/i,
    },
  },
  {
    page: 19,
    slotId: "p19_ru_knowledge_2",
    sectionKey: "ru_knowledge",
    kind: "knowledge_visual",
    template: "orion_golden_knowledge_panel",
    title: "Россия — панель знаний (2)",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["ru_knowledge"],
      templates: ["orion_golden_knowledge_panel"],
      assetRefRe: /^(?:ru)_knowledge_panel_2$/i,
    },
  },
  {
    page: 20,
    slotId: "p20_ru_related_1",
    sectionKey: "15_ru_related_queries",
    kind: "related_visual",
    template: "orion_golden_surface_panel",
    title: "Россия — связанные запросы (1)",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["15_ru_related_queries"],
      templates: ["orion_golden_surface_panel", "orion_golden_prose"],
      assetRefRe: /ru_related(_1|_yandex)?$/i,
    },
  },
  {
    page: 21,
    slotId: "p21_ru_related_2",
    sectionKey: "15_ru_related_queries",
    kind: "related_visual",
    template: "orion_golden_surface_panel",
    title: "Россия — связанные запросы (2)",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["15_ru_related_queries"],
      templates: ["orion_golden_surface_panel", "orion_golden_prose"],
      assetRefRe: /ru_related_2|ru_related_google/i,
    },
  },
  {
    page: 22,
    slotId: "p22_ru_related_3",
    sectionKey: "15_ru_related_queries",
    kind: "related_visual",
    template: "orion_golden_surface_panel",
    title: "Россия — связанные запросы (3)",
    region: "RU",
    requiredVisual: false,
    match: {
      sectionKeys: ["15_ru_related_queries"],
      templates: ["orion_golden_surface_panel", "orion_golden_prose"],
      assetRefRe: /ru_related_3/i,
    },
  },
  {
    page: 23,
    slotId: "p23_uae_toc",
    sectionKey: "uae_digital_profile",
    kind: "region_toc",
    template: "orion_golden_region_divider",
    title: "ОАЭ — цифровой профиль",
    region: "UAE",
    requiredVisual: false,
    match: { sectionKeys: ["uae_digital_profile"], templates: ["orion_golden_region_divider"] },
  },
  {
    page: 24,
    slotId: "p24_uae_summary",
    sectionKey: "30_uae_audit_summary",
    kind: "summary",
    template: "orion_golden_prose",
    title: "ОАЭ — резюме аудита",
    region: "UAE",
    requiredVisual: false,
    match: { sectionKeys: ["30_uae_audit_summary"] },
  },
  {
    page: 25,
    slotId: "p25_uae_metrics",
    sectionKey: "31_uae_google_search_links",
    kind: "metrics",
    template: "orion_golden_prose",
    title: "ОАЭ — показатели поиска",
    region: "UAE",
    requiredVisual: false,
    match: { sectionKeys: ["31_uae_google_search_links", "uae_search_results"] },
  },
  {
    page: 26,
    slotId: "p26_uae_serp_table",
    sectionKey: "32_uae_serp_position_table",
    kind: "search_table",
    template: "orion_golden_search_table",
    title: "ОАЭ — позиции в SERP",
    region: "UAE",
    requiredVisual: false,
    match: {
      sectionKeys: ["32_uae_serp_position_table"],
      templates: ["orion_golden_search_table"],
    },
  },
  {
    page: 27,
    slotId: "p27_uae_serp_visual",
    sectionKey: "uae_serp_screenshots",
    kind: "serp_visual",
    template: "orion_golden_serp_screenshot",
    title: "ОАЭ — снимок выдачи",
    region: "UAE",
    requiredVisual: true,
    match: {
      sectionKeys: ["uae_serp_screenshots"],
      templates: ["orion_golden_serp_screenshot"],
      assetRefRe: /uae|intl|ae_/i,
    },
  },
  {
    page: 28,
    slotId: "p28_uae_suggestions",
    sectionKey: "33_uae_suggestions",
    kind: "suggestions_visual",
    template: "orion_golden_surface_panel",
    title: "ОАЭ — подсказки поиска",
    region: "UAE",
    requiredVisual: false,
    match: {
      sectionKeys: ["33_uae_suggestions"],
      templates: ["orion_golden_surface_panel", "orion_golden_prose"],
      assetRefRe: /uae_suggestions/i,
    },
  },
  {
    page: 29,
    slotId: "p29_uae_wikipedia",
    sectionKey: "35_uae_wikipedia",
    kind: "wikipedia",
    template: "orion_golden_prose",
    title: "ОАЭ — Википедия",
    region: "UAE",
    requiredVisual: false,
    match: { sectionKeys: ["35_uae_wikipedia", "uae_wikipedia"] },
  },
  {
    page: 30,
    slotId: "p30_uae_images",
    sectionKey: "uae_images",
    kind: "image_visual",
    template: "orion_golden_image_grid",
    title: "ОАЭ — изображения в поиске",
    region: "UAE",
    requiredVisual: false,
    match: {
      sectionKeys: ["uae_images"],
      templates: ["orion_golden_image_grid"],
      assetRefRe: /^(?:uae)_image_grid/i,
    },
  },
  {
    page: 31,
    slotId: "p31_uae_knowledge",
    sectionKey: "uae_knowledge",
    kind: "knowledge_visual",
    template: "orion_golden_knowledge_panel",
    title: "ОАЭ — панель знаний",
    region: "UAE",
    requiredVisual: false,
    match: {
      sectionKeys: ["uae_knowledge"],
      templates: ["orion_golden_knowledge_panel"],
      assetRefRe: /uae.*knowledge/i,
    },
  },
  {
    page: 32,
    slotId: "p32_uae_related",
    sectionKey: "34_uae_related_queries",
    kind: "related_visual",
    template: "orion_golden_surface_panel",
    title: "ОАЭ — связанные запросы",
    region: "UAE",
    requiredVisual: false,
    match: {
      sectionKeys: ["34_uae_related_queries"],
      templates: ["orion_golden_surface_panel", "orion_golden_prose"],
      assetRefRe: /uae_related/i,
    },
  },
  {
    page: 33,
    slotId: "p33_compliance_toc",
    sectionKey: "compliance_toc",
    kind: "compliance_toc",
    template: "orion_golden_region_divider",
    title: "Комплаенс-базы",
    region: "COMPLIANCE",
    requiredVisual: false,
    match: { sectionKeys: ["40_compliance_database_summary"] },
  },
  {
    page: 34,
    slotId: "p34_dow_jones",
    sectionKey: "42_dow_jones_profile",
    kind: "db_visual",
    template: "orion_golden_compliance_visual_page",
    title: "Dow Jones — профиль",
    region: "COMPLIANCE",
    requiredVisual: false,
    match: {
      sectionKeys: ["42_dow_jones_profile", "dow_jones", "dow_jones_visual"],
      templates: ["orion_golden_compliance_visual_page", "orion_golden_prose"],
      assetRefRe: /dow_jones_visual/i,
    },
  },
  {
    page: 35,
    slotId: "p35_lexis_visual",
    sectionKey: "lexisnexis_visual",
    kind: "db_visual",
    template: "orion_golden_lexis_visual_page",
    title: "LexisNexis — страница профиля",
    region: "COMPLIANCE",
    requiredVisual: true,
    match: {
      sectionKeys: ["lexisnexis_visual", "lexisnexis", "44_lexisnexis_profile"],
      templates: ["orion_golden_lexis_visual_page"],
      assetRefRe: /lexis/i,
    },
  },
  {
    page: 36,
    slotId: "p36_lexis_visual_2",
    sectionKey: "lexisnexis_visual",
    kind: "db_visual",
    template: "orion_golden_lexis_visual_page",
    title: "LexisNexis — страница профиля (2)",
    region: "COMPLIANCE",
    requiredVisual: true,
    match: {
      sectionKeys: ["lexisnexis_visual", "lexisnexis"],
      templates: ["orion_golden_lexis_visual_page"],
      assetRefRe: /lexis/i,
    },
  },
];

export const FIRST36_EXACT_PAGE_COUNT = ORION_FIRST36_REGISTRY_V1.length;

export function assertFirst36RegistryIntegrity(): void {
  if (ORION_FIRST36_REGISTRY_V1.length !== 36) {
    throw new Error(`first36-registry-length:${ORION_FIRST36_REGISTRY_V1.length}`);
  }
  for (let i = 0; i < ORION_FIRST36_REGISTRY_V1.length; i += 1) {
    if (ORION_FIRST36_REGISTRY_V1[i]!.page !== i + 1) {
      throw new Error(`first36-registry-page-order:${i + 1}`);
    }
  }
}
