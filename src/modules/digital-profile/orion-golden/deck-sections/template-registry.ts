/**
 * Deterministic design templates. LLM never creates layout: static framework
 * text (block labels, methodology, legend) lives here; only client conclusions
 * / evidence / risk / actions arrive from SectionPacks.
 *
 * `rendererTemplate` maps every template to an EXISTING renderer layout id
 * (orion_golden_*) so no second renderer is created.
 */

export type DeckTemplateId =
  | "cover"
  | "toc"
  | "executive-summary"
  | "risk-matrix"
  | "regional-summary"
  | "finding-cards"
  | "serp-table"
  | "serp-screenshot-analysis"
  | "suggestions"
  | "image-grid"
  | "wikipedia-knowledge"
  | "ai-overview"
  | "related-queries"
  | "coverage-empty-state"
  | "section-divider"
  | "continuation";

/** Static layout metadata: grid, typography, spacing. Never LLM-controlled. */
export type TemplateLayoutSpec = {
  /** Named grid of the slide body. */
  grid: "single-column" | "two-column" | "sidebar-right" | "full-bleed" | "table" | "divider";
  /** Body font size in pt (titles are grid-defined by the renderer theme). */
  bodyFontPt: number;
  titleFontPt: number;
  /** Vertical gap between blocks, pt. */
  blockGapPt: number;
  /** Character budget for the main narrative block. */
  narrativeCharBudget: number;
  /** Character budget per bullet/table cell. */
  itemCharBudget: number;
  /** Pagination rule: what happens when content exceeds the budgets. */
  pagination: "continuation" | "clamp" | "none";
};

export type DeckTemplateDef = {
  templateId: DeckTemplateId;
  /** Existing renderer layout (orion_golden_renderer.py `_render_slide`). */
  rendererTemplate: string;
  /** Static block labels rendered by the template, not by the LLM. */
  staticBlocks: string[];
  /** Static methodology note (framework copy, identical across reports). */
  methodologyNote?: string;
  /** Static legend entries (e.g. marker semantics). */
  legend?: string[];
  /** Max dynamic bullets per slide before a continuation is required. */
  maxBulletsPerSlide: number;
  /** Max table rows per slide before a continuation is required. */
  maxTableRowsPerSlide: number;
  /** Static grid/typography/spacing/budget spec for this SlideKind. */
  layout: TemplateLayoutSpec;
};

/**
 * Version of the static layout layer only. Bumping it (template-only change)
 * must NOT invalidate SectionPacks — packs hash analytical inputs, not layout.
 * The assembler/render stage picks up the new layout on reassembly.
 */
export const TEMPLATE_LAYOUT_VERSION = "deck-templates-layout-v1";

const LAYOUT_DEFAULTS: Omit<TemplateLayoutSpec, "grid"> = {
  bodyFontPt: 12,
  titleFontPt: 22,
  blockGapPt: 10,
  narrativeCharBudget: 600,
  itemCharBudget: 400,
  pagination: "continuation",
};

function layout(grid: TemplateLayoutSpec["grid"], overrides: Partial<TemplateLayoutSpec> = {}): TemplateLayoutSpec {
  return { ...LAYOUT_DEFAULTS, grid, ...overrides };
}

// Short enough to fit the table's status column without clipping; keeps the
// "нежелат" stem the renderer's row-tone detector matches on.
export const RED_MARKER_LABEL = "Нежелательный" as const;

const FINDING_BLOCKS = ["Что обнаружено", "Почему важно", "Что проверить", "Источник"];

export const DECK_TEMPLATE_REGISTRY: Record<DeckTemplateId, DeckTemplateDef> = {
  cover: {
    templateId: "cover",
    rendererTemplate: "orion_golden_cover",
    staticBlocks: ["Конфиденциально", "Отчёт о цифровом профиле"],
    maxBulletsPerSlide: 6,
    maxTableRowsPerSlide: 0,
    layout: layout("full-bleed", { titleFontPt: 34, narrativeCharBudget: 300, pagination: "none" }),
  },
  toc: {
    templateId: "toc",
    rendererTemplate: "orion_golden_toc",
    staticBlocks: ["Содержание"],
    maxBulletsPerSlide: 14,
    maxTableRowsPerSlide: 0,
    layout: layout("single-column", { pagination: "clamp", itemCharBudget: 120 }),
  },
  "executive-summary": {
    templateId: "executive-summary",
    rendererTemplate: "orion_golden_executive_dashboard",
    staticBlocks: ["Общий вывод", "Ключевые факты", "Приоритетные действия"],
    methodologyNote:
      "Выводы опираются только на проверенные факты с указанием источника; предварительные сигналы отмечены отдельно.",
    maxBulletsPerSlide: 8,
    maxTableRowsPerSlide: 0,
    layout: layout("two-column", { narrativeCharBudget: 620, itemCharBudget: 360 }),
  },
  "risk-matrix": {
    templateId: "risk-matrix",
    rendererTemplate: "orion_golden_risk_matrix_grid",
    staticBlocks: ["Матрица рисков", "Уровень", "Тема", "Статус"],
    legend: ["Критический", "Высокий", "Средний", "Низкий"],
    maxBulletsPerSlide: 0,
    maxTableRowsPerSlide: 10,
    layout: layout("table", { itemCharBudget: 80 }),
  },
  "regional-summary": {
    templateId: "regional-summary",
    rendererTemplate: "orion_golden_metrics_dashboard",
    staticBlocks: ["Обзор региона", ...FINDING_BLOCKS],
    methodologyNote:
      "Метрики рассчитаны только по материалам, отнесённым к проверяемому лицу; совпадения по однофамильцам исключены из KPI.",
    maxBulletsPerSlide: 8,
    maxTableRowsPerSlide: 0,
    layout: layout("two-column", { narrativeCharBudget: 500, itemCharBudget: 360 }),
  },
  "finding-cards": {
    templateId: "finding-cards",
    rendererTemplate: "orion_golden_executive_card",
    staticBlocks: FINDING_BLOCKS,
    maxBulletsPerSlide: 6,
    maxTableRowsPerSlide: 0,
    layout: layout("two-column", { itemCharBudget: 360 }),
  },
  "serp-table": {
    templateId: "serp-table",
    rendererTemplate: "orion_golden_search_table",
    staticBlocks: ["Результаты поиска", "Позиция", "Домен", "Заголовок", "Оценка"],
    legend: [RED_MARKER_LABEL, "Вероятно", "Нейтральный", "Позитивный"],
    methodologyNote:
      "Домены выводятся из URL источника; оценка присваивается по содержанию материала. «Вероятно» — принадлежность субъекту не подтверждена однозначно.",
    maxBulletsPerSlide: 0,
    maxTableRowsPerSlide: 12,
    layout: layout("table", { itemCharBudget: 110 }),
  },
  "serp-screenshot-analysis": {
    templateId: "serp-screenshot-analysis",
    rendererTemplate: "orion_golden_serp_screenshot",
    staticBlocks: ["Скриншот выдачи", ...FINDING_BLOCKS],
    maxBulletsPerSlide: 6,
    maxTableRowsPerSlide: 0,
    layout: layout("sidebar-right", { narrativeCharBudget: 420 }),
  },
  suggestions: {
    templateId: "suggestions",
    rendererTemplate: "orion_golden_surface_panel",
    staticBlocks: ["Поисковые подсказки", ...FINDING_BLOCKS],
    methodologyNote:
      "Подсказки отражают частотные запросы пользователей и формируют первое впечатление о субъекте.",
    maxBulletsPerSlide: 10,
    maxTableRowsPerSlide: 0,
    layout: layout("sidebar-right", { itemCharBudget: 220 }),
  },
  "image-grid": {
    templateId: "image-grid",
    rendererTemplate: "orion_golden_image_grid",
    staticBlocks: ["Изображения в выдаче", ...FINDING_BLOCKS],
    maxBulletsPerSlide: 6,
    maxTableRowsPerSlide: 0,
    layout: layout("sidebar-right", { itemCharBudget: 320 }),
  },
  "wikipedia-knowledge": {
    templateId: "wikipedia-knowledge",
    rendererTemplate: "orion_golden_knowledge_panel",
    staticBlocks: ["Википедия и панель знаний", ...FINDING_BLOCKS],
    methodologyNote:
      "Раздел фиксирует, как справочные ресурсы идентифицируют субъекта и с кем его могут путать поисковые системы.",
    maxBulletsPerSlide: 8,
    maxTableRowsPerSlide: 0,
    layout: layout("sidebar-right", { narrativeCharBudget: 480 }),
  },
  "ai-overview": {
    templateId: "ai-overview",
    rendererTemplate: "orion_golden_surface_panel",
    staticBlocks: ["AI-ответы поисковых систем", ...FINDING_BLOCKS],
    methodologyNote:
      "Ответы AI-сервисов приводятся полностью, без сокращений; интерпретация даётся отдельным блоком.",
    maxBulletsPerSlide: 6,
    maxTableRowsPerSlide: 0,
    layout: layout("single-column", { itemCharBudget: 1200, pagination: "continuation" }),
  },
  "related-queries": {
    templateId: "related-queries",
    rendererTemplate: "orion_golden_surface_panel",
    staticBlocks: ["Связанные запросы", ...FINDING_BLOCKS],
    maxBulletsPerSlide: 10,
    maxTableRowsPerSlide: 0,
    layout: layout("sidebar-right", { itemCharBudget: 220 }),
  },
  "coverage-empty-state": {
    templateId: "coverage-empty-state",
    rendererTemplate: "orion_golden_no_data_compact",
    staticBlocks: ["Покрытие данных", "Статус сбора", "Что это означает"],
    methodologyNote:
      "Отсутствие материалов по поверхности не тождественно отсутствию рисков; указан фактический статус сбора.",
    maxBulletsPerSlide: 4,
    maxTableRowsPerSlide: 0,
    layout: layout("single-column", { narrativeCharBudget: 360, pagination: "none" }),
  },
  "section-divider": {
    templateId: "section-divider",
    rendererTemplate: "orion_golden_region_divider",
    staticBlocks: [],
    maxBulletsPerSlide: 4,
    maxTableRowsPerSlide: 0,
    layout: layout("divider", { titleFontPt: 30, pagination: "none" }),
  },
  continuation: {
    templateId: "continuation",
    rendererTemplate: "orion_golden_surface_panel",
    staticBlocks: ["Продолжение"],
    maxBulletsPerSlide: 10,
    maxTableRowsPerSlide: 12,
    layout: layout("single-column", {}),
  },
};

export function getTemplate(templateId: DeckTemplateId): DeckTemplateDef {
  return DECK_TEMPLATE_REGISTRY[templateId];
}
