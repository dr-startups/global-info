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
  /**
   * То же для страницы-продолжения, если её ёмкость измерена отдельно.
   *
   * `maxBulletsPerSlide` калибруется по **первой** странице блока, где над
   * содержимым стоит обвязка: KPI-плитки, нарратив, карточка «Действие». С
   * шага 13 (D3/D4) продолжения её не несут, и место у них другое. Не
   * задано — ёмкость продолжения равна ёмкости первой страницы, как было.
   */
  maxBulletsPerContinuation?: number;
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
export const TEMPLATE_LAYOUT_VERSION = "deck-templates-layout-v2";

/** A named, pre-built alternative rendering of a template (level 2.5). */
export type TemplateLayoutVariantDef = {
  id: string;
  /** Client-safe description shown to the GPT composer when it picks layouts. */
  description: string;
};

/**
 * Per-template layout variants the GPT composer may choose from. The default
 * rendering (no variant) is always valid. Every variant maps to a
 * deterministic layout implemented in the Python renderer — GPT never invents
 * geometry, it only selects among vetted, pre-built options.
 */
export const TEMPLATE_LAYOUT_VARIANTS: Partial<
  Record<DeckTemplateId, TemplateLayoutVariantDef[]>
> = {
  "section-divider": [
    {
      id: "hero",
      description:
        "Акцентный титульный разворот раздела: цветная плашка, крупный заголовок и лид-абзац о содержании раздела. Подходит, когда у раздела есть содержательный вводный текст.",
    },
  ],
  "finding-cards": [
    {
      id: "accent-headline",
      description:
        "Главный вывод страницы выделен акцентной карточкой, детали — списком под ним. Подходит для страниц с одним сильным выводом и короткими деталями.",
    },
  ],
  "regional-summary": [
    {
      id: "kpi-first",
      description:
        "Числовые показатели региона крупными карточками сверху, текстовый вывод под ними. Подходит, когда цифры выразительнее текста.",
    },
  ],
};

/** Fail-closed check used by the composer validator and the assembler. */
export function isAllowedLayoutVariant(templateId: string, variant: string): boolean {
  const defs = TEMPLATE_LAYOUT_VARIANTS[templateId as DeckTemplateId];
  return Boolean(defs?.some((d) => d.id === variant));
}

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
    legend: ["Критический", "Высокий", "Средний", "Низкий", "Требует подтверждения"],
    // PDF-46 I.3 — capacity enforced in packRiskMatrixPages (3 cards/page).
    maxBulletsPerSlide: 0,
    maxTableRowsPerSlide: 3,
    layout: layout("table", { itemCharBudget: 80 }),
  },
  "regional-summary": {
    templateId: "regional-summary",
    rendererTemplate: "orion_golden_metrics_dashboard",
    staticBlocks: ["Обзор региона", ...FINDING_BLOCKS],
    methodologyNote:
      "Метрики рассчитаны только по материалам, отнесённым к проверяемому лицу; совпадения по однофамильцам исключены из KPI.",
    // PDF-46 I.3 — with KPI chrome only 2 multi-line theme cards fit above
    // the footer; overflow continues on the next page (more pages OK).
    maxBulletsPerSlide: 2,
    // Замер на страницах финального прогона (шаг 16, 07.6): без KPI-плиток,
    // нарратива и карточки «Действие» страница-продолжение принимает три
    // тематических блока, занимая ~83 % полосы содержимого. Два оставляли
    // пустыми от 30 до 70 % листа — пять страниц «Россия — резюме аудита»
    // подряд, последняя с одним блоком в 115 знаков.
    maxBulletsPerContinuation: 3,
    maxTableRowsPerSlide: 0,
    layout: layout("two-column", { narrativeCharBudget: 700, itemCharBudget: 860 }),
  },
  "finding-cards": {
    templateId: "finding-cards",
    rendererTemplate: "orion_golden_executive_card",
    staticBlocks: FINDING_BLOCKS,
    maxBulletsPerSlide: 6,
    maxTableRowsPerSlide: 0,
    layout: layout("two-column", { itemCharBudget: 860 }),
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
    // PDF-46 I.3 — theme continuations stay airy; table rows still chunk separately.
    maxBulletsPerSlide: 3,
    maxTableRowsPerSlide: 12,
    layout: layout("single-column", {}),
  },
};

export function getTemplate(templateId: DeckTemplateId): DeckTemplateDef {
  return DECK_TEMPLATE_REGISTRY[templateId];
}
