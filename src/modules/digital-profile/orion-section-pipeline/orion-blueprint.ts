import type { OrionBlueprint, OrionDataNeeds, OrionMacroSection, OrionMicroStage } from "./types";

const DEFAULT_OUTPUT_CONTRACT = {
  requiredFields: ["clientNarrative", "evidenceSummary", "slideContent", "warnings"] as string[],
  clientSafe: true,
  internalNotesAllowed: true,
};

const DEFAULT_QA_CHECKS = [
  { id: "strict-json-shape", description: "Output follows strict JSON schema.", severity: "P0" as const },
  { id: "client-safe-text", description: "No internal/debug markers in client text.", severity: "P0" as const },
  { id: "evidence-traceability", description: "Every key claim maps to evidence refs.", severity: "P1" as const },
];

const COMMON_EXCLUDE = [
  "local paths",
  "storage keys",
  "signed urls",
  "private document full text",
  "raw prompts",
  "raw model responses",
  "secrets",
  "api keys",
  "internal provider stack traces",
];

function needs(include: string[], constraints: string[]): OrionDataNeeds {
  return { include, exclude: COMMON_EXCLUDE, constraints };
}

function stage(
  macroSectionKey: string,
  sectionNumber: string | null,
  order: number,
  input: {
    microStageKey: string;
    titleRu: string;
    expectedSlideCountMin: number;
    expectedSlideCountMax: number;
    dataNeeds: OrionDataNeeds;
    requiredAgents: string[];
    requiresGpt55Analysis: boolean;
    requiresEvidence: boolean;
    requiresVisualEvidence: boolean;
    slideTemplateKey: string;
  }
): OrionMicroStage {
  return {
    macroSectionKey,
    sectionNumber,
    order,
    outputContract: { ...DEFAULT_OUTPUT_CONTRACT },
    qaChecks: [...DEFAULT_QA_CHECKS],
    ...input,
  };
}

function sec(input: {
  macroSectionKey: string;
  sectionNumber: string | null;
  titleRu: string;
  order: number;
  slideType: string;
  hasSectionToc?: boolean;
  computedAfterComposition?: boolean;
  microStages: OrionMicroStage[];
}): OrionMacroSection {
  return {
    hasSectionToc: Boolean(input.hasSectionToc),
    computedAfterComposition: input.computedAfterComposition,
    ...input,
  };
}

export function loadOrionBlueprint(): OrionBlueprint {
  const macroSections: OrionMacroSection[] = [
    sec({
      macroSectionKey: "cover",
      sectionNumber: null,
      titleRu: "Обложка",
      order: 1,
      slideType: "cover",
      microStages: [
        stage("cover", null, 101, {
          microStageKey: "cover",
          titleRu: "Обложка",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["subject", "date", "case title"], ["dynamic subject/date only"]),
          requiredAgents: [],
          requiresGpt55Analysis: false,
          requiresEvidence: false,
          requiresVisualEvidence: false,
          slideTemplateKey: "cover_orion",
        }),
      ],
    }),
    sec({
      macroSectionKey: "toc_global",
      sectionNumber: null,
      titleRu: "Глобальное содержание",
      order: 2,
      slideType: "toc",
      computedAfterComposition: true,
      microStages: [
        stage("toc_global", null, 201, {
          microStageKey: "toc_global",
          titleRu: "Глобальное содержание",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(["macro sections order", "computed page starts"], ["computed only after composition"]),
          requiredAgents: [],
          requiresGpt55Analysis: false,
          requiresEvidence: false,
          requiresVisualEvidence: false,
          slideTemplateKey: "toc_orion",
        }),
      ],
    }),
    sec({
      macroSectionKey: "executive",
      sectionNumber: "1",
      titleRu: "Резюме",
      order: 3,
      slideType: "executive",
      hasSectionToc: false,
      microStages: [
        stage("executive", "1", 301, {
          microStageKey: "executive_narrative_summary",
          titleRu: "Резюме: нарратив",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            ["overall risk", "confirmed findings", "requires_review findings", "regional high-level conclusions"],
            ["no legal overclaims", "ambiguous findings must remain requires_review"]
          ),
          requiredAgents: ["AUDIT_SUMMARY_BUILDER", "RISK_CLASSIFIER_V1"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "executive_narrative_summary",
        }),
        stage("executive", "1", 302, {
          microStageKey: "compliance_risk_matrix",
          titleRu: "Матрица комплаенс-рисков",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            ["Dow Jones / World-Check / LexisNexis summary metrics", "confirmed/potential/review buckets"],
            ["manual review status explicit", "no confirmation inflation"]
          ),
          requiredAgents: ["COMPLIANCE_DATABASE"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "compliance_risk_matrix",
        }),
        stage("executive", "1", 303, {
          microStageKey: "digital_profile_risk_overview",
          titleRu: "Обзор рисков цифрового профиля",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            ["RU/INTL search risk totals", "image/video/suggestions impacts", "Wikipedia state"],
            ["must align with downstream RU/UAE micro-stages"]
          ),
          requiredAgents: ["REAL_ORION_SEARCH_PROFILE", "REAL_ORION_UAE_INTERNATIONAL", "REAL_ORION_GOOGLE_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "digital_profile_risk_overview",
        }),
      ],
    }),
    sec({
      macroSectionKey: "ru_profile",
      sectionNumber: "2",
      titleRu: "Россия: Цифровой профиль",
      order: 4,
      slideType: "regional",
      hasSectionToc: true,
      microStages: [
        stage("ru_profile", "2", 401, {
          microStageKey: "ru_audit_summary",
          titleRu: "2.1 Резюме аудита",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            ["RU regional totals", "risk level", "top risk domains/themes", "evidence refs"],
            ["counts must match RU downstream stages"]
          ),
          requiredAgents: ["REAL_ORION_SEARCH_PROFILE", "AUDIT_SUMMARY_BUILDER"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "regional_audit_summary",
        }),
        stage("ru_profile", "2", 402, {
          microStageKey: "ru_search_links_overview",
          titleRu: "2.2 Результаты поиска: обзор ссылок",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            [
              "subject RU queries",
              "Yandex top20",
              "Google top20",
              "undesirable links count",
              "unique undesirable URLs",
              "neutral/undesirable classification",
              "top adverse themes",
              "SERP screenshots/synthetic screenshots",
              "source domains",
              "evidence refs",
            ],
            ["micro-stage scope only"]
          ),
          requiredAgents: ["REAL_YANDEX_SEARCH", "REAL_GOOGLE_SEARCH", "REAL_ORION_SEARCH_PROFILE"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "search_links_overview",
        }),
        stage("ru_profile", "2", 403, {
          microStageKey: "ru_top20_serp_matrix",
          titleRu: "2.2 ТОП-20 SERP матрица",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            [
              "top20 positions by query/provider",
              "domain",
              "URL",
              "title",
              "classification neutral/undesirable/requires_review/noise",
              "theme id",
              "evidence ref",
              "row/column coordinates",
            ],
            ["deterministic row order"]
          ),
          requiredAgents: ["REAL_YANDEX_SEARCH", "REAL_GOOGLE_SEARCH"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "top20_serp_matrix",
        }),
        stage("ru_profile", "2", 404, {
          microStageKey: "ru_adverse_themes_serp_examples",
          titleRu: "2.2 Негативные темы и примеры SERP",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            [
              "grouped adverse themes",
              "count per theme",
              "representative SERP snippets",
              "screenshot cards with red boxes",
              "domains",
              "evidence refs",
              "client-safe explanation",
            ],
            ["no generic repeated theme labels"]
          ),
          requiredAgents: ["REAL_ORION_SEARCH_PROFILE", "REAL_SEARCH_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "adverse_themes_serp_examples",
        }),
        stage("ru_profile", "2", 405, {
          microStageKey: "ru_yandex_suggestions",
          titleRu: "2.2 Яндекс подсказки",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(
            ["query variants", "suggestions list", "adverse suggestion count", "neutral/adverse classification", "why suggestions matter"],
            ["explicit requires_review wording for ambiguous suggestions"]
          ),
          requiredAgents: ["REAL_YANDEX_SEARCH", "REAL_SEARCH_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "search_suggestions",
        }),
        stage("ru_profile", "2", 406, {
          microStageKey: "ru_google_suggestions",
          titleRu: "2.2 Google подсказки",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(
            ["query variants", "suggestions list", "adverse suggestion count", "neutral/adverse classification", "why suggestions matter"],
            ["explicit requires_review wording for ambiguous suggestions"]
          ),
          requiredAgents: ["REAL_GOOGLE_SEARCH", "REAL_SEARCH_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "search_suggestions",
        }),
        stage("ru_profile", "2", 407, {
          microStageKey: "ru_wikipedia",
          titleRu: "2.3 Википедия",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(
            ["article presence", "article URL", "title", "summary", "status exists/absent/wrong_subject/requires_review", "why Wikipedia matters", "recommended action"],
            ["wrong subject must not be treated as confirmed fact"]
          ),
          requiredAgents: ["REAL_WIKIPEDIA"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "wikipedia_profile",
        }),
        stage("ru_profile", "2", 408, {
          microStageKey: "ru_yandex_images",
          titleRu: "2.2 Яндекс изображения",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            ["image results", "image thumbnails", "source pages/domains", "adverse image count", "theme classification", "visual evidence refs", "why images matter"],
            ["visual refs required"]
          ),
          requiredAgents: ["REAL_YANDEX_SEARCH", "REAL_SEARCH_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "image_results_analysis",
        }),
        stage("ru_profile", "2", 409, {
          microStageKey: "ru_google_images",
          titleRu: "2.2 Google изображения",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            ["image results", "image thumbnails", "source pages/domains", "adverse image count", "theme classification", "visual evidence refs", "why images matter"],
            ["visual refs required"]
          ),
          requiredAgents: ["REAL_GOOGLE_SEARCH", "REAL_SEARCH_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "image_results_analysis",
        }),
        stage("ru_profile", "2", 410, {
          microStageKey: "ru_yandex_knowledge_panel",
          titleRu: "2.2 Яндекс knowledge panel",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(
            ["panel presence", "subject match", "wrong person detection", "panel source", "undesirable content status", "screenshot", "explanation"],
            ["wrong subject must be highlighted as requires_review"]
          ),
          requiredAgents: ["REAL_YANDEX_SEARCH", "REAL_SEARCH_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "knowledge_panel_analysis",
        }),
        stage("ru_profile", "2", 411, {
          microStageKey: "ru_google_knowledge_panel",
          titleRu: "2.2 Google knowledge panel",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(
            ["panel presence", "subject match", "wrong person detection", "panel source", "undesirable content status", "screenshot", "explanation"],
            ["wrong subject must be highlighted as requires_review"]
          ),
          requiredAgents: ["REAL_GOOGLE_SEARCH", "REAL_SEARCH_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "knowledge_panel_analysis",
        }),
        stage("ru_profile", "2", 412, {
          microStageKey: "ru_yandex_related_queries",
          titleRu: "2.2 Яндекс related queries",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(
            ["related queries", "adverse related count", "query labels", "explanation"],
            ["ambiguous labels remain requires_review"]
          ),
          requiredAgents: ["REAL_YANDEX_SEARCH", "REAL_SEARCH_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "related_queries_analysis",
        }),
        stage("ru_profile", "2", 413, {
          microStageKey: "ru_google_related_queries",
          titleRu: "2.2 Google related queries",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(
            ["related queries", "adverse related count", "query labels", "explanation"],
            ["ambiguous labels remain requires_review"]
          ),
          requiredAgents: ["REAL_GOOGLE_SEARCH", "REAL_SEARCH_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "related_queries_analysis",
        }),
      ],
    }),
    sec({
      macroSectionKey: "uae_profile",
      sectionNumber: "3",
      titleRu: "ОАЭ: Цифровой профиль",
      order: 5,
      slideType: "regional",
      hasSectionToc: true,
      microStages: [
        stage("uae_profile", "3", 501, {
          microStageKey: "uae_audit_summary",
          titleRu: "3.1 Резюме аудита",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            ["UAE/INTL totals", "English/transliteration variants", "top risk themes/domains"],
            ["sanctions/PEP/watchlist context must remain requires_review unless confirmed"]
          ),
          requiredAgents: ["REAL_ORION_UAE_INTERNATIONAL", "AUDIT_SUMMARY_BUILDER"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "regional_audit_summary",
        }),
        stage("uae_profile", "3", 502, {
          microStageKey: "uae_google_search_links_overview",
          titleRu: "3.2 Результаты поиска: обзор ссылок",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            [
              "English/UAE queries",
              "Google top20",
              "undesirable links count",
              "unique undesirable URLs",
              "neutral/undesirable/requires_review classification",
              "English adverse themes",
              "SERP screenshots",
              "domains",
              "evidence refs",
            ],
            ["transliteration variants included"]
          ),
          requiredAgents: ["REAL_GOOGLE_SEARCH", "REAL_ORION_UAE_INTERNATIONAL", "REAL_ORION_GOOGLE_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "search_links_overview",
        }),
        stage("uae_profile", "3", 503, {
          microStageKey: "uae_google_top20_serp_matrix",
          titleRu: "3.2 ТОП-20 SERP матрица",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            ["top20 positions by query", "domain", "URL", "title", "classification", "theme id", "evidence ref"],
            ["deterministic row order"]
          ),
          requiredAgents: ["REAL_GOOGLE_SEARCH"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "top20_serp_matrix",
        }),
        stage("uae_profile", "3", 504, {
          microStageKey: "uae_adverse_themes_serp_examples",
          titleRu: "3.2 Негативные темы и примеры SERP",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(
            ["grouped adverse themes", "count per theme", "SERP snippets", "screenshot cards", "domains", "evidence refs", "client-safe explanation"],
            ["sanctions/PEP/offshore/watchlist framed as requires_review unless confirmed"]
          ),
          requiredAgents: ["REAL_ORION_UAE_INTERNATIONAL", "REAL_ORION_GOOGLE_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "adverse_themes_serp_examples",
        }),
        stage("uae_profile", "3", 505, {
          microStageKey: "uae_google_suggestions",
          titleRu: "3.2 Google подсказки",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["query variants", "suggestions list", "adverse suggestion count", "classification", "why suggestions matter"], ["English locale focused"]),
          requiredAgents: ["REAL_GOOGLE_SEARCH", "REAL_ORION_GOOGLE_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "search_suggestions",
        }),
        stage("uae_profile", "3", 506, {
          microStageKey: "uae_wikipedia",
          titleRu: "3.3 Википедия",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["article presence", "article URL", "title", "summary", "status", "why Wikipedia matters", "recommended action"], ["English/UAE context"]),
          requiredAgents: ["REAL_WIKIPEDIA"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "wikipedia_profile",
        }),
        stage("uae_profile", "3", 507, {
          microStageKey: "uae_google_images",
          titleRu: "3.2 Google изображения",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 2,
          dataNeeds: needs(["image results", "image thumbnails", "source pages/domains", "adverse image count", "theme classification", "visual refs"], ["English/UAE context"]),
          requiredAgents: ["REAL_GOOGLE_SEARCH", "REAL_ORION_GOOGLE_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "image_results_analysis",
        }),
        stage("uae_profile", "3", 508, {
          microStageKey: "uae_google_knowledge_panel",
          titleRu: "3.2 Google knowledge panel",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["panel presence", "subject match", "wrong person detection", "source", "undesirable status", "screenshot"], ["wrong subject detection mandatory"]),
          requiredAgents: ["REAL_GOOGLE_SEARCH", "REAL_ORION_GOOGLE_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "knowledge_panel_analysis",
        }),
        stage("uae_profile", "3", 509, {
          microStageKey: "uae_google_related_queries",
          titleRu: "3.2 Google related queries",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["related queries", "adverse related count", "query labels", "explanation"], ["English/UAE context"]),
          requiredAgents: ["REAL_GOOGLE_SEARCH", "REAL_ORION_GOOGLE_SURFACES"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "related_queries_analysis",
        }),
      ],
    }),
    sec({
      macroSectionKey: "compliance_databases",
      sectionNumber: "4",
      titleRu: "Dow Jones, World-Check, LexisNexis",
      order: 6,
      slideType: "compliance",
      hasSectionToc: true,
      microStages: [
        stage("compliance_databases", "4", 601, {
          microStageKey: "dow_jones_profile_overview",
          titleRu: "Dow Jones: профиль",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["provider hits", "review status", "categories", "relationships", "source links"], ["no legal overclaims"]),
          requiredAgents: ["COMPLIANCE_DATABASE"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "dow_jones_profile_overview",
        }),
        stage("compliance_databases", "4", 602, {
          microStageKey: "world_check_profile_overview",
          titleRu: "World-Check: профиль",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["provider hits", "review status", "categories", "relationships", "source links"], ["no legal overclaims"]),
          requiredAgents: ["COMPLIANCE_DATABASE"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "world_check_profile_overview",
        }),
        stage("compliance_databases", "4", 603, {
          microStageKey: "lexisnexis_profile_overview",
          titleRu: "LexisNexis: профиль",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(
            ["uploaded LexisNexis DOCX/PDF/images", "parsed safe signals", "PEP/RCA/watchlist categories", "relationships", "biography fields", "manual review status"],
            ["requires review by default for ambiguous signals"]
          ),
          requiredAgents: ["COMPLIANCE_DATABASE"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "lexisnexis_profile_overview",
        }),
        stage("compliance_databases", "4", 604, {
          microStageKey: "lexisnexis_visual_pages",
          titleRu: "LexisNexis: визуальные страницы",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 8,
          dataNeeds: needs(["converted visual pages", "page refs", "safe captions", "visual evidence refs"], ["no fake visuals"]),
          requiredAgents: ["COMPLIANCE_DATABASE"],
          requiresGpt55Analysis: false,
          requiresEvidence: true,
          requiresVisualEvidence: true,
          slideTemplateKey: "lexisnexis_visual_page",
        }),
        stage("compliance_databases", "4", 605, {
          microStageKey: "compliance_database_summary_for_risk_matrix",
          titleRu: "Сводка для матрицы рисков",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["provider totals", "confirmed/potential/requires_review/excluded buckets", "key domains/themes"], ["must align with executive matrix"]),
          requiredAgents: ["COMPLIANCE_DATABASE"],
          requiresGpt55Analysis: true,
          requiresEvidence: true,
          requiresVisualEvidence: false,
          slideTemplateKey: "compliance_risk_matrix",
        }),
      ],
    }),
    sec({
      macroSectionKey: "offer",
      sectionNumber: "5",
      titleRu: "Наше предложение",
      order: 7,
      slideType: "offer",
      hasSectionToc: true,
      microStages: [
        ...[
          ["client_pain_request", "Запрос клиента", "offer_client_pain"],
          ["compliance_problem_context", "Контекст комплаенс-проблемы", "offer_context"],
          ["why_compliance_is_concerned", "Почему комплаенс обеспокоен", "offer_context"],
          ["target_client_profiles", "Целевые профили клиентов", "offer_context"],
          ["service_map", "Карта сервиса", "offer_service_map"],
          ["why_not_delete_but_create_profile", "Почему не удалять, а создавать профиль", "offer_context"],
          ["solution_1_digital_profile_divider", "Решение 1: разделитель", "offer_solution_divider"],
          ["digital_profile_before_after_search_examples", "До/после: поисковая выдача", "offer_before_after"],
          ["search_result_displacement_examples", "Примеры вытеснения результатов", "offer_before_after"],
          ["example_links", "Примеры ссылок", "offer_before_after"],
          ["example_biographies", "Примеры биографий", "offer_before_after"],
          ["effective_digital_profile_example", "Пример эффективного цифрового профиля", "offer_before_after"],
          ["digital_profile_implementation_plan", "План внедрения цифрового профиля", "offer_implementation_plan"],
          ["biography_content_requirements", "Требования к контенту биографии", "offer_implementation_plan"],
          ["reporting_and_kpi", "Отчетность и KPI", "offer_implementation_plan"],
          ["client_inputs_required", "Что требуется от клиента", "offer_implementation_plan"],
          ["ru_digital_profile_packages", "Пакеты RU цифрового профиля", "offer_budget_table"],
          ["intl_digital_profile_packages", "Пакеты INTL цифрового профиля", "offer_budget_table"],
          ["online_business_card_case", "Кейс online business card", "offer_case_study"],
          ["solution_2_compliance_db_divider", "Решение 2: разделитель", "offer_solution_divider"],
          ["compliance_db_profile_correction", "Коррекция профиля в комплаенс БД", "offer_context"],
          ["compliance_db_workflow", "Workflow комплаенс БД", "offer_implementation_plan"],
          ["compliance_db_budget_timing", "Бюджет и сроки комплаенс БД", "offer_budget_table"],
          ["solution_3_wikipedia_divider", "Решение 3: разделитель", "offer_solution_divider"],
          ["wikipedia_before_after", "Wikipedia до/после", "offer_before_after"],
          ["wikipedia_implementation_plan", "План внедрения Wikipedia", "offer_implementation_plan"],
          ["ru_wikipedia_budget", "Бюджет RU Wikipedia", "offer_budget_table"],
          ["en_wikipedia_budget", "Бюджет EN Wikipedia", "offer_budget_table"],
          ["how_to_start", "Как начать", "how_to_start"],
        ].map((row, idx) =>
          stage("offer", "5", 701 + idx, {
            microStageKey: row[0]!,
            titleRu: row[1]!,
            expectedSlideCountMin: 1,
            expectedSlideCountMax: 1,
            dataNeeds: needs(
              [
                "configured commercial content",
                "adaptation flags from findings",
                "search risk emphasis",
                "compliance DB correction emphasis",
                "Wikipedia solution emphasis",
              ],
              ["no hallucinated pricing unless configured"]
            ),
            requiredAgents: [],
            requiresGpt55Analysis: true,
            requiresEvidence: false,
            requiresVisualEvidence: false,
            slideTemplateKey: row[2]!,
          })
        ),
      ],
    }),
    sec({
      macroSectionKey: "about",
      sectionNumber: "6",
      titleRu: "О нас",
      order: 8,
      slideType: "about",
      hasSectionToc: true,
      microStages: [
        stage("about", "6", 801, {
          microStageKey: "about_company_media",
          titleRu: "О компании и медиа",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["company profile content", "media references", "client-safe narrative"], ["no unsupported claims"]),
          requiredAgents: [],
          requiresGpt55Analysis: false,
          requiresEvidence: false,
          requiresVisualEvidence: false,
          slideTemplateKey: "about_company",
        }),
        stage("about", "6", 802, {
          microStageKey: "competition",
          titleRu: "Конкуренция",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["competitive positioning", "differentiators"], ["no legal/commercial overclaims"]),
          requiredAgents: [],
          requiresGpt55Analysis: false,
          requiresEvidence: false,
          requiresVisualEvidence: false,
          slideTemplateKey: "competition",
        }),
        stage("about", "6", 803, {
          microStageKey: "ai_search_impact",
          titleRu: "Влияние AI-поиска",
          expectedSlideCountMin: 1,
          expectedSlideCountMax: 1,
          dataNeeds: needs(["AI search trends narrative", "impact on digital profile strategy"], ["no fabricated quantitative claims"]),
          requiredAgents: [],
          requiresGpt55Analysis: false,
          requiresEvidence: false,
          requiresVisualEvidence: false,
          slideTemplateKey: "ai_search_impact",
        }),
      ],
    }),
  ];

  return {
    mode: "orion_section_pipeline_v1",
    version: "r9.0.0",
    generatedAt: new Date().toISOString(),
    macroSections,
  };
}

