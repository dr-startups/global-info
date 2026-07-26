/**
 * R10.6 — Canonical ORION section registry (client_audit mode).
 * Commercial ORION blocks (offer, about) are excluded from analytical audit mode.
 */

export type OrionReportMode = "client_audit" | "commercial_proposal_mode";

export type OrionSectionGroup =
  | "identity"
  | "executive"
  | "ru_digital_profile"
  | "uae_digital_profile"
  | "compliance_databases"
  | "review_and_appendix";

export type OrionAnalysisMode =
  | "GPT_SECTION_ANALYSIS"
  | "DETERMINISTIC_AGGREGATION"
  | "APPENDIX_ONLY"
  | "EXECUTIVE_SYNTHESIS"
  | "RISK_MATRIX_SYNTHESIS";

export type OrionAllowedClientUse =
  | "MAIN_ANALYSIS"
  | "CAVEATED_ANALYSIS"
  | "APPENDIX_ONLY"
  | "MANUAL_REVIEW_ONLY";

export type OrionSectionRegistryEntry = {
  sectionId: string;
  order: number;
  titleRu: string;
  titleEn: string;
  sectionGroup: OrionSectionGroup;
  sectionPurpose: string;
  analysisMode: OrionAnalysisMode;
  isClientFacing: boolean;
  isAnalytical: boolean;
  isCommercial: boolean;
  applicableRegions: Array<"RU" | "UAE" | "INTL" | "GLOBAL">;
  requiredEvidenceTypes: string[];
  allowedClientUses: OrionAllowedClientUse[];
  dependsOnSectionIds: string[];
};

function sec(
  sectionId: string,
  order: number,
  titleRu: string,
  titleEn: string,
  sectionGroup: OrionSectionGroup,
  sectionPurpose: string,
  analysisMode: OrionAnalysisMode,
  opts: Partial<Omit<OrionSectionRegistryEntry, "sectionId" | "order" | "titleRu" | "titleEn" | "sectionGroup" | "sectionPurpose" | "analysisMode">> = {}
): OrionSectionRegistryEntry {
  return {
    sectionId,
    order,
    titleRu,
    titleEn,
    sectionGroup,
    sectionPurpose,
    analysisMode,
    isClientFacing: opts.isClientFacing ?? true,
    isAnalytical: opts.isAnalytical ?? true,
    isCommercial: opts.isCommercial ?? false,
    applicableRegions: opts.applicableRegions ?? ["RU", "UAE", "INTL", "GLOBAL"],
    requiredEvidenceTypes: opts.requiredEvidenceTypes ?? [],
    allowedClientUses: opts.allowedClientUses ?? ["MAIN_ANALYSIS", "CAVEATED_ANALYSIS"],
    dependsOnSectionIds: opts.dependsOnSectionIds ?? [],
  };
}

/** Commercial ORION sections excluded from client_audit — documented for future commercial_proposal_mode. */
export const ORION_COMMERCIAL_SECTION_IDS = [
  "commercial_offer",
  "commercial_offer_51",
  "commercial_offer_52",
  "commercial_offer_53",
  "commercial_offer_54",
  "commercial_about_us",
] as const;

export const ORION_SECTION_REGISTRY: OrionSectionRegistryEntry[] = [
  sec("00_case_identity", 0, "Идентификация субъекта", "Case identity", "identity", "Подтверждение субъекта проверки и базовых идентификаторов.", "DETERMINISTIC_AGGREGATION", {
    requiredEvidenceTypes: [],
    allowedClientUses: ["MAIN_ANALYSIS"],
  }),
  sec("01_executive_summary", 1, "Резюме для руководства", "Executive summary", "executive", "Сводный управленческий вывод на основе секционных анализов.", "EXECUTIVE_SYNTHESIS", {
    dependsOnSectionIds: ["10_ru_audit_summary", "40_compliance_database_summary"],
    allowedClientUses: ["MAIN_ANALYSIS", "CAVEATED_ANALYSIS"],
  }),
  sec("02_compliance_risk_matrix", 2, "Матрица compliance-рисков", "Compliance risk matrix", "executive", "Агрегированная матрица рисков из секционных выводов.", "RISK_MATRIX_SYNTHESIS", {
    dependsOnSectionIds: ["01_executive_summary"],
    allowedClientUses: ["MAIN_ANALYSIS", "CAVEATED_ANALYSIS"],
  }),
  sec("03_digital_profile_overview", 3, "Обзор цифрового профиля", "Digital profile overview", "executive", "Краткий обзор цифрового следа субъекта по регионам.", "GPT_SECTION_ANALYSIS", {
    requiredEvidenceTypes: ["search_result"],
    allowedClientUses: ["MAIN_ANALYSIS", "CAVEATED_ANALYSIS"],
  }),

  sec("10_ru_audit_summary", 10, "Россия — резюме аудита", "RU audit summary", "ru_digital_profile", "Сводка цифрового аудита по РФ.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["search_result", "risk_finding"] }),
  sec("11_ru_search_links", 11, "Россия — ссылки поисковой выдачи", "RU search links", "ru_digital_profile", "Ключевые ссылки российской поисковой выдачи.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["search_result"] }),
  sec("12_ru_serp_position_table", 12, "Россия — позиции в SERP", "RU SERP positions", "ru_digital_profile", "Таблица позиций в поисковой выдаче.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["serp_screenshot", "search_result"] }),
  sec("13_ru_undesirable_theme_clusters", 13, "Россия — нежелательные тематические кластеры", "RU undesirable themes", "ru_digital_profile", "Кластеры потенциально негативных или двусмысленных тем.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["search_result", "risk_finding"] }),
  sec("14_ru_yandex_suggestions", 14, "Россия — подсказки Яндекс", "RU Yandex suggestions", "ru_digital_profile", "Подсказки автодополнения Яндекс.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["suggestion"] }),
  sec("15_ru_google_suggestions", 15, "Россия — подсказки Google", "RU Google suggestions", "ru_digital_profile", "Подсказки автодополнения Google (RU).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["suggestion"] }),
  sec("16_ru_wikipedia", 16, "Россия — Википедия", "RU Wikipedia", "ru_digital_profile", "Публичный справочный профиль Википедии.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["wikipedia"] }),
  sec("17_ru_yandex_images", 17, "Россия — изображения Яндекс", "RU Yandex images", "ru_digital_profile", "Визуальный контекст в выдаче Яндекс.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["image", "search_surface_image"] }),
  sec("18_ru_google_images", 18, "Россия — изображения Google", "RU Google images", "ru_digital_profile", "Визуальный контекст в выдаче Google (RU).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["image", "search_surface_image"] }),
  sec("19_ru_videos", 19, "Россия — видео", "RU videos", "ru_digital_profile", "Видеоконтент в цифровом профиле.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["video", "search_surface_video"] }),
  sec("20_ru_yandex_knowledge_panel", 20, "Россия — панель знаний Яндекс", "RU Yandex knowledge panel", "ru_digital_profile", "Панель знаний Яндекс.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["knowledge", "search_surface_knowledge"] }),
  sec("21_ru_google_knowledge_panel", 21, "Россия — панель знаний Google", "RU Google knowledge panel", "ru_digital_profile", "Панель знаний Google (RU).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["knowledge", "search_surface_knowledge"] }),
  sec("22_ru_yandex_related_queries", 22, "Россия — смежные запросы Яндекс", "RU Yandex related queries", "ru_digital_profile", "Смежные поисковые запросы Яндекс.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["suggestion", "related_query"] }),
  sec("23_ru_google_related_queries", 23, "Россия — смежные запросы Google", "RU Google related queries", "ru_digital_profile", "Смежные поисковые запросы Google (RU).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["RU", "GLOBAL"], requiredEvidenceTypes: ["suggestion", "related_query"] }),

  sec("30_uae_audit_summary", 30, "ОАЭ — резюме аудита", "UAE audit summary", "uae_digital_profile", "Сводка цифрового аудита по ОАЭ.", "GPT_SECTION_ANALYSIS", { applicableRegions: ["UAE", "INTL"], requiredEvidenceTypes: ["search_result", "risk_finding"] }),
  sec("31_uae_google_search_links", 31, "ОАЭ — ссылки Google", "UAE Google search links", "uae_digital_profile", "Ссылки поисковой выдачи Google (ОАЭ).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["UAE", "INTL"], requiredEvidenceTypes: ["search_result"] }),
  sec("32_uae_serp_position_table", 32, "ОАЭ — позиции SERP", "UAE SERP positions", "uae_digital_profile", "Позиции в выдаче Google (ОАЭ).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["UAE", "INTL"], requiredEvidenceTypes: ["serp_screenshot", "search_result"] }),
  sec("33_uae_undesirable_theme_clusters", 33, "ОАЭ — нежелательные тематические кластеры", "UAE undesirable themes", "uae_digital_profile", "Кластеры потенциально негативных тем (ОАЭ).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["UAE", "INTL"], requiredEvidenceTypes: ["search_result", "risk_finding"] }),
  sec("34_uae_google_suggestions", 34, "ОАЭ — подсказки Google", "UAE Google suggestions", "uae_digital_profile", "Подсказки Google (ОАЭ).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["UAE", "INTL"], requiredEvidenceTypes: ["suggestion"] }),
  sec("35_uae_wikipedia", 35, "ОАЭ — Википедия", "UAE Wikipedia", "uae_digital_profile", "Справочный профиль Википедии (ОАЭ).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["UAE", "INTL"], requiredEvidenceTypes: ["wikipedia"] }),
  sec("36_uae_google_images", 36, "ОАЭ — изображения Google", "UAE Google images", "uae_digital_profile", "Изображения Google (ОАЭ).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["UAE", "INTL"], requiredEvidenceTypes: ["image", "search_surface_image"] }),
  sec("37_uae_google_videos", 37, "ОАЭ — видео Google", "UAE Google videos", "uae_digital_profile", "Видео Google (ОАЭ).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["UAE", "INTL"], requiredEvidenceTypes: ["video", "search_surface_video"] }),
  sec("38_uae_google_knowledge_panel", 38, "ОАЭ — панель знаний Google", "UAE Google knowledge panel", "uae_digital_profile", "Панель знаний Google (ОАЭ).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["UAE", "INTL"], requiredEvidenceTypes: ["knowledge", "search_surface_knowledge"] }),
  sec("39_uae_google_related_queries", 39, "ОАЭ — смежные запросы Google", "UAE Google related queries", "uae_digital_profile", "Смежные запросы Google (ОАЭ).", "GPT_SECTION_ANALYSIS", { applicableRegions: ["UAE", "INTL"], requiredEvidenceTypes: ["suggestion", "related_query"] }),

  sec("40_compliance_database_summary", 40, "Compliance — сводка баз данных", "Compliance database summary", "compliance_databases", "Обобщение проверок по compliance-базам.", "GPT_SECTION_ANALYSIS", { requiredEvidenceTypes: ["compliance_hit", "database_profile"] }),
  sec("41_sanctions_watchlists", 41, "Санкции и watchlist", "Sanctions and watchlists", "compliance_databases", "Совпадения по санкциям и watchlist.", "GPT_SECTION_ANALYSIS", { requiredEvidenceTypes: ["compliance_hit", "risk_finding"] }),
  sec("42_dow_jones_profile", 42, "Dow Jones профиль", "Dow Jones profile", "compliance_databases", "Материалы Dow Jones.", "GPT_SECTION_ANALYSIS", { requiredEvidenceTypes: ["compliance_hit", "database_profile"] }),
  sec("43_world_check_profile", 43, "World-Check профиль", "World-Check profile", "compliance_databases", "Материалы World-Check.", "GPT_SECTION_ANALYSIS", { requiredEvidenceTypes: ["compliance_hit", "database_profile"] }),
  sec("44_lexisnexis_profile", 44, "LexisNexis профиль", "LexisNexis profile", "compliance_databases", "Материалы LexisNexis.", "GPT_SECTION_ANALYSIS", { requiredEvidenceTypes: ["compliance_hit", "database_profile"] }),
  sec("45_compliance_media_check", 45, "Compliance media check", "Compliance media check", "compliance_databases", "Adverse media в compliance-контексте.", "GPT_SECTION_ANALYSIS", { requiredEvidenceTypes: ["compliance_hit", "risk_finding", "search_result"] }),
  sec("46_other_public_databases", 46, "Прочие публичные базы", "Other public databases", "compliance_databases", "Прочие публичные реестры и базы.", "GPT_SECTION_ANALYSIS", { requiredEvidenceTypes: ["database_profile", "compliance_hit"] }),

  sec("50_manual_review_required", 50, "Материалы, требующие ручной проверки", "Manual review required", "review_and_appendix", "Материалы, не подтверждённые автоматически.", "DETERMINISTIC_AGGREGATION", {
    allowedClientUses: ["MANUAL_REVIEW_ONLY", "CAVEATED_ANALYSIS"],
  }),
  sec("51_excluded_noise_summary", 51, "Исключённый шум", "Excluded noise summary", "review_and_appendix", "Сводка исключённого шума.", "DETERMINISTIC_AGGREGATION", {
    isAnalytical: false,
    allowedClientUses: ["APPENDIX_ONLY"],
  }),
  sec("52_limitations", 52, "Ограничения проверки", "Limitations", "review_and_appendix", "Методологические ограничения.", "DETERMINISTIC_AGGREGATION", {
    allowedClientUses: ["MAIN_ANALYSIS", "CAVEATED_ANALYSIS"],
  }),
  sec("53_recommendations", 53, "Рекомендации", "Recommendations", "review_and_appendix", "Рекомендации на основе секционных выводов.", "DETERMINISTIC_AGGREGATION", {
    dependsOnSectionIds: ["01_executive_summary"],
    allowedClientUses: ["MAIN_ANALYSIS"],
  }),
  sec("54_evidence_appendix", 54, "Приложение — доказательная база", "Evidence appendix", "review_and_appendix", "Приложенческие материалы.", "APPENDIX_ONLY", {
    allowedClientUses: ["APPENDIX_ONLY", "CAVEATED_ANALYSIS"],
  }),
];

export function getClientAuditSections(): OrionSectionRegistryEntry[] {
  return ORION_SECTION_REGISTRY.filter((s) => !s.isCommercial);
}

export function getGptSectionAnalysisEntries(): OrionSectionRegistryEntry[] {
  return getClientAuditSections().filter((s) => s.analysisMode === "GPT_SECTION_ANALYSIS");
}

export function getSectionById(sectionId: string): OrionSectionRegistryEntry | undefined {
  return ORION_SECTION_REGISTRY.find((s) => s.sectionId === sectionId);
}

export const ORION_REPORT_MODES = {
  client_audit: "client_audit" as OrionReportMode,
  /** Placeholder — not implemented in R10.6 */
  commercial_proposal_mode: "commercial_proposal_mode" as OrionReportMode,
};
