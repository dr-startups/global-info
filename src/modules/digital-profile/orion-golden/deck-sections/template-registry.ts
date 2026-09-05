/**
 * Deterministic design templates. LLM never creates layout: static framework
 * text (block labels, methodology, legend) lives here; only client conclusions
 * / evidence / risk / actions arrive from SectionPacks.
 *
 * `rendererTemplate` maps every template to an EXISTING renderer layout id
 * (orion_golden_*) so no second renderer is created.
 */

import { CLIENT_RISK_LABELS } from "../client/risk-scale";

export type DeckTemplateId =
  | "cover"
  | "toc"
  | "executive-summary"
  | "risk-matrix"
  | "regional-summary"
  | "finding-cards"
  | "serp-table"
  | "serp-extra-queries"
  | "serp-screenshot-analysis"
  | "suggestions"
  | "image-grid"
  | "wikipedia-knowledge"
  | "wikipedia-check"
  | "ai-overview"
  | "related-queries"
  | "coverage-empty-state"
  | "persona-check"
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
  /**
   * Сколько знаков списка помещается на **первый** лист — по мере рендерера.
   *
   * Ёмкость страницы измеряется, а не считается: `maxBulletsPerSlide` верно для
   * коротких строк выдачи, но высота блока растёт не пропорционально их числу,
   * и произведение «счёт × бюджет знака» на длинных буллетах ошибается в разы.
   * Замер страницы Википедии голден-кейса (`/orion/measure-layout`):
   * `availableHeight` 1 542 687 EMU, блок в 253–331 знак — 822 784 EMU, то есть
   * на лист входит один такой буллет. Без объявленной ёмкости рендерер молча
   * оставлял на листе один буллет из трёх, а нарратив рядом утверждал, что
   * каждый фрагмент приведён дословно.
   *
   * Объявляется только там, где ёмкость **померена**: не объявлено — прежнее
   * поведение, ограничение по счёту.
   */
  maxBulletCharsPerSlide?: number;
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
  /**
   * Сколько блоков кладёт на лист **первый заход** сборки.
   *
   * Это предложение, а не ёмкость. Ёмкость страницы знает только код
   * отрисовки рендерера, и с шага «страница набирается по мере» её спрашивают
   * мерным прогоном: разбивку определяет вердикт меры, а это число нужно
   * первой итерации и офлайн-сборкам, где рендерера нет и ничего не
   * публикуется. Чинить здесь потерю содержимого бесполезно — числом на
   * вопрос о высоте уже отвечали, и оно промахнулось на 0,37 %.
   */
  maxBulletsPerSlide: number;
  /**
   * То же для страницы-продолжения: на ней нет KPI-обвязки, места больше.
   *
   * Не задано — сид продолжения равен сиду первой страницы, как было.
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

/**
 * Оценка материала о другом лице.
 *
 * Однофамилец занимает своё место в выдаче, и вычёркивать его строку нельзя:
 * аудит обещает ТОП-20, а дыра в нумерации читается как потеря данных. Но и
 * «Нейтральный» ему не годится — это оценка материала о субъекте.
 */
export const OTHER_SUBJECT_LABEL = "О другом лице" as const;

/**
 * Оценка строки, чью страницу не открывали, — третье значение колонки.
 *
 * «Нейтральный» — это результат проверки: страницу прочитали и негатива не
 * нашли. На отчёте Кремлёва так стояли 14 напечатанных строк из 38, у которых
 * никакой проверки не было вовсе: девять с отказом чтения, пять без вердикта.
 * Читатель отличить их не мог, а разница между «проверили, чисто» и «не
 * заходили» — это и есть предмет аудита.
 */
export const UNVERIFIED_LABEL = "Не проверено" as const;

/**
 * Совпало только имя: признака, отличающего материал от материала полного
 * тёзки, нет. Стоит **выше** «Нежелательного» — отчёт читает сам субъект, и
 * чужой негатив, покрашенный красным, стоит ему денег на удаление чужого
 * материала; приглушённый свой сигнал при этом остаётся в приложении
 * (решение владельца 04.09.2026).
 */
export const UNCONFIRMED_SUBJECT_LABEL = "Принадлежность не подтверждена" as const;

/**
 * Сколько знаков боковая панель отдаёт одной фразе «Почему выделено».
 *
 * Это ёмкость узкой колонки, а не решение построителя: рендерер режет фразу
 * по границе предложения и молча отбрасывает то, что не поместилось. Пока
 * число стояло только в сборке payload, построитель собирал фразу вслепую и
 * терял в ней адрес — то самое предложение, ради которого фразу и читают.
 */
/**
 * Сколько знаков абзаца доезжает до карточной страницы.
 *
 * Число померено, а не назначено. Замер повторяется так: карточка рисуется тем
 * же вызовом, каким её рисует рендерер (`slides.py` → `_render_status_cards` →
 * `content_card` с `min_h=380_000`, `max_h=1_700_000`, `padding=100_000`,
 * `title_size=11`, `body_size=FS_BODY=11`), после чего длина нарисованного
 * сравнивается с длиной поданного:
 *
 *   y после `ctx.title(320_000)` = 1 270 000
 *   budget = min(1 700 000, CONTENT_BOTTOM − y) = 1 700 000
 *   title_h («Результат проверки», жирный 11 pt) = 219 572
 *   bodyBudget = 1 280 428 EMU при inner_w = 10 544 320
 *
 * Ёмкость достигается **понижением кегля**: `_scale_steps_below(11) = [9]`,
 * то есть карточка шагает с 11 pt сразу на 9 pt и лишь потом режет (на 11 pt
 * входит ≈709 знаков). Мелкий кегль на этих страницах принят сознательно.
 *
 * Шрифт пропорциональный, поэтому ёмкость зависит от текста: 1016 знаков на
 * абзаце золотого кейса, 1022 на абзаце эталона-72, 1102 на прозе с адресами и
 * латиницей, 1146 на коротких словах. Объявляется **пол** диапазона, а не
 * максимум: бюджет обязан ошибаться в сторону запрета — карточка выбрасывает
 * невлезшее до отрисовки и не пишет об этом ни `record_text_layout`, ни
 * `droppedLines`, так что потерю не видит ни телеметрия, ни ворота приёмки.
 *
 * Число ниже пола и потому консервативно; поднимать его до 1102 нельзя — на
 * тексте золотого кейса ёмкость 1016.
 */
export const CARD_NARRATIVE_CHAR_BUDGET = 998;

/**
 * Сколько знаков 11 pt держит колонка боковой панели — на все её блоки разом.
 *
 * Число померено, а не назначено. Геометрия колонки выведена из самого
 * рендерера (`_render_visual_with_sidebar` → `_sidebar_analysis`):
 *
 *   ctx.title(280 000)                    → 1 230 000
 *   верх панели  = 1 230 000 + 60 000     = 1 290 000   (visual.py)
 *   cy старт     = верх + pad(70 000)     = 1 360 000
 *   max_bottom   = низ панели − pad       = 6 065 200
 *   колонка      = 6 065 200 − 1 360 000  = 4 705 200 EMU
 *
 * Из колонки на текст остаётся меньше: три заголовка блоков по 200 000, четыре
 * отбивки по 55 000 и пол 160 000, который `write_block` держит под подпись
 * источников, — итого 3 725 200 EMU при ширине текста 3 822 842. Двоичный
 * поиск той же мерой, какой меряет рендерер (`measure_text_height`), на
 * реальных текстах панелей эталона-72 и прогона 92 дал **694…765** знаков при
 * медиане 734.
 *
 * Объявляется **пол** диапазона с запасом, а не максимум: шрифт
 * пропорциональный, латиница и адреса занимают больше кириллицы, и ошибаться
 * это число обязано в сторону запрета. Поднимать его выше замеренного пола
 * нельзя — разницу молча выбросит рендерер снизу, то есть последним блоком, и
 * ни телеметрия панели, ни ворота приёмки не скажут, какой именно.
 *
 * Бюджеты отдельных полей панели (300 у вывода, 260 у рекомендации, 240 у
 * объяснения рамки, 300 + 140 у значимости, 420 у нарратива) ёмкостью **не
 * являются**: это потолки читаемости, «сколько уместно дать одному блоку».
 * Ёмкость — одна, и она здесь.
 */
export const SIDEBAR_COLUMN_CHAR_BUDGET = 660;

export const SIDEBAR_HIGHLIGHT_BUDGET = 240;

/** Сколько фраз панель успевает нарисовать; остальные уходят на продолжение. */
export const SIDEBAR_HIGHLIGHT_SLOTS = 2;

/**
 * Сколько высоты остаётся строкам таблицы выдачи, EMU.
 *
 *   низ белой сцены                6 110 200  (фигура orion_card_pNN)
 *   верх вводного абзаца         − 1 230 000
 *   потолок вводного абзаца      − 1 000 000  (SEARCH_TABLE_INTRO_MAX_H)
 *   отбивка под абзацем          −    40 000
 *   шапка таблицы                −   330 200  (26 pt)
 *   бюджет строк                 = 3 510 000
 *
 * Верх берётся **объявленный**, а не фактический: `ctx.body` за `max_h` выйти
 * не может, поэтому рост вводного абзаца ёмкость не двигает вовсе, а
 * выведенная из факта ёмкость зависела бы от длины текста и промахнулась бы на
 * живом прогоне.
 */
export const SERP_TABLE_ROW_BUDGET_EMU = 3_510_000;

/**
 * Высота худшей законной строки таблицы выдачи, EMU.
 *
 * Меряется мерой самого рендерера (`_wrapped_line_count`) на колонке адреса —
 * 328 px полезных при доле 0.34. Худшее законное письмо — предел адреса (165
 * знаков), написанный самым широким знаком 9 pt («Ю», 12,15 px): семь
 * нарисованных строк, 7 × 137 160 + отбивка 76 200 = 1 036 320. Заголовок на
 * своём пределе (95 знаков одним словом) даёт пять строк — 762 000, то есть
 * высоту строки задаёт адрес.
 *
 * Замер на четырёх видах письма (обычная латиница, процентный код, кириллица,
 * предельное письмо самым широким знаком) дал 4, 5, 4 и 7 строк. Взята
 * последняя: ёмкость обязана держаться при **любом** законном письме, а не при
 * встреченном. Опереться на «а если не влезет, сработает CRITICAL» нельзя:
 * `TABLE_ROW_PARTIALLY_VISIBLE` входит в `CLIP_CODES`
 * (`services/render-telemetry-gate.ts`), но клип таблицы блокирует выдачу
 * только на странице комплаенс-раздела. У страницы выдачи превышение бюджета —
 * одна строка в `job.warnings`, а страница уезжает клиенту нарисованной мимо
 * поля.
 *
 * Пересчитать число обязана любая правка обвязки страницы выдачи: другой
 * потолок вводного абзаца, лишний блок над таблицей, другие пределы заголовка
 * (`SERP_TITLE_MAX_CHARS`) или адреса (`SERP_ADDRESS_MAX_CHARS`), другие доли
 * колонок в `_add_search_table`.
 */
export const SERP_TABLE_WORST_ROW_EMU = 1_036_320;

/**
 * Высота худшей законной строки таблицы «Найдено по дополнительным запросам».
 *
 * У неё пять колонок, но других: `Ссылка · Заголовок · Найдено по запросу ·
 * Тип источника · Оценка`. Худшая строка меряется так же — `_wrapped_line_count`
 * на предельных значениях построителей, самым широким знаком 9 pt («Ю»,
 * 12,15 px):
 *
 *   адрес     165 знаков при 0.30 листа (287 px полезных) — 7 строк
 *   заголовок  95 знаков при 0.20 листа (186 px)          — 7 строк
 *   запрос     80 знаков при 0.16 листа (145 px)          — 7 строк
 *
 * Три широких колонки уравнены намеренно: доли выбирались так, чтобы худшая
 * строка второй таблицы совпала с худшей строкой первой, и ёмкость у обеих
 * была одна. При долях `[0.30, 0.22, 0.14, …]` колонка запроса даёт **восемь**
 * строк (1 173 480 EMU) и роняет ёмкость до 2, то есть удваивает число листов.
 *
 * Предел запроса — `SERP_FOUND_BY_MAX_CHARS` (`fragment-builders/serp.ts`), и
 * его же читает смок ширин: у вопроса «сколько знаков влезает в колонку
 * запроса» один ответ. Опираться на предел набора запросов аудита
 * (`MAX_QUERY_CHARS`) здесь нельзя — в деку текст едет другим путём, и план
 * сбора строит запрос с региональной подсказкой длиннее восьмидесяти знаков;
 * почему так, объяснено при самой константе.
 */
export const SERP_EXTRA_TABLE_WORST_ROW_EMU = 1_036_320;

// Каркас страницы с находкой. Подписи «Что обнаружено / Почему важно / Что
// проверить» отсюда убраны: они превращали каждую страницу в бланк проверки, а
// их содержание теперь идёт связным абзацем (см. composeFindingProse в
// run-deck-build). Ссылка на источник — не утверждение о субъекте, поэтому
// остаётся отдельным блоком.
const FINDING_BLOCKS = ["Источник"];

/**
 * Шаблоны, у которых абзац рисует `content_card`, — и потому обрезается молча.
 *
 * `_render_status_cards` рендерера (её зовут ровно две раскладки:
 * `orion_golden_no_data_compact` и `orion_golden_wikipedia_check`) отдаёт
 * абзац в `content_card`, а тот подгоняет текст под высоту **до** отрисовки,
 * телеметрии о себе не пишет вовсе и `droppedLines` не выставляет. Значит,
 * потерю не видит ни геометрия, ни блокирующее правило приёмки, и удержать её
 * можно только до рендера — сравнив длину абзаца с мерянной ёмкостью листа.
 *
 * Остальные раскладки о потере сообщают сами: приборная страница резюме
 * пишет `dropped_bullets` (`executive.py:125-132`), список — через
 * `ctx.bullets`. Там ёмкость сторожит `CONTENT_DROPPED_BY_RENDERER`, и второй
 * сторож с числом «на глаз» только мешал бы: объявленные бюджеты этих
 * шаблонов — сид раскладки, а не замер, и абзац резюме их законно перерастает.
 */
export const SILENTLY_CLIPPED_NARRATIVE_TEMPLATES: ReadonlySet<DeckTemplateId> = new Set([
  "wikipedia-check",
  "coverage-empty-state",
  "persona-check",
]);

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
    // Ступени — с клиентской шкалы; «Требует подтверждения» стоит рядом с
    // ними как статус идентификации, а не как четвёртая ступень.
    legend: [...CLIENT_RISK_LABELS, "Требует подтверждения"],
    maxBulletsPerSlide: 0,
    /*
     * Единственный ответ на вопрос «сколько карточек на листе».
     *
     * Раньше их было четыре: константа построителя, это поле, срез маппинга и
     * срез рендерера. Расхождение было безвредным ровно до первой правки
     * ёмкости — после неё лишние темы молча срезались бы на пути к рендереру.
     * Построитель читает ёмкость отсюда, маппинг и рендерер список не режут.
     *
     * Три — по замеру рендерера **худшей легальной** карточки, а не типичной.
     * Под сеткой на листе 4 925 200 EMU (лист без полосы заголовка и нижнего
     * зазора), между карточками 50 000. Худшее, что выпускает построитель при
     * бюджетах ниже: заголовок 72 знака, строка «в чём проблема» 160 и «Что
     * делать» на остатке — по две нарисованные строки каждая, карточка
     * 1 307 808 EMU. Три занимают 4 023 424 и помещаются, четыре требуют
     * 5 381 232 и нет. Типичная сводная карточка (тело в две строки) стоит
     * 906 117, и таких на лист влезает пять — но ёмкость, посчитанная по
     * типичной, дважды теряла карточки живого прогона: не влезшая карточка не
     * рисуется вовсе и с недавних пор останавливает выдачу отчёта.
     *
     * Плата за «три» — лишняя страница матрицы начиная с четырёх тем: при
     * ёмкости 4 четыре темы лежали на одном листе, а правило хвоста делит их
     * на 2 + 2, а не на 3 + 1. Числа держит смок
     * `renderer/smoke_risk_matrix_cards.py` (К6 и К10): три худших легальных
     * карточки нарисованы целиком и без потерь, а сама мера сверена с
     * растровым замером страницы эталона.
     */
    maxTableRowsPerSlide: 3,
    /*
     * Бюджет тела сводной карточки: строка «в чём проблема» (≈160 знаков — две
     * нарисованных строки при ширине текста карточки) плюс строка «Что делать»
     * или оговорка о принадлежности.
     */
    layout: layout("table", { itemCharBudget: 320 }),
  },
  "regional-summary": {
    templateId: "regional-summary",
    rendererTemplate: "orion_golden_metrics_dashboard",
    staticBlocks: ["Обзор региона", ...FINDING_BLOCKS],
    methodologyNote:
      "Метрики рассчитаны только по материалам, отнесённым к проверяемому лицу; совпадения по однофамильцам исключены из KPI.",
    // Сид первого захода: над списком стоят KPI-плитки, нарратив и карточка
    // «Действие», и больше двух блоков там обычно не бывает. Финальную
    // разбивку определяет мера рендерера.
    maxBulletsPerSlide: 2,
    // На продолжении обвязки нет, места больше — сид крупнее.
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
    staticBlocks: ["Результаты поиска", "№", "Ссылка", "Заголовок", "Тип источника", "Оценка"],
    /*
     * Легенда обещает ровно те значения, которые колонка печатает, — в том
     * порядке, в каком они выбираются. «Позитивный» построитель не печатал
     * никогда, а «О другом лице» печатал и в легенде не значился: обещание
     * маркера, которого нет, и молчание о маркере, который есть.
     */
    legend: [
      OTHER_SUBJECT_LABEL,
      UNCONFIRMED_SUBJECT_LABEL,
      RED_MARKER_LABEL,
      "Вероятно",
      UNVERIFIED_LABEL,
      "Нейтральный",
    ],
    methodologyNote:
      "Полный адрес материала напечатан в колонке «Ссылка»; оценка присваивается по содержанию материала. «Вероятно» — принадлежность субъекту не подтверждена однозначно. «Не проверено» — страница материала не открывалась, и негативных признаков в заголовке нет.",
    maxBulletsPerSlide: 0,
    /*
     * Ёмкость листа таблицы выдачи не назначается, а делится: оба слагаемых
     * вывода объявлены именованными числами выше (`SERP_TABLE_ROW_BUDGET_EMU`
     * и `SERP_TABLE_WORST_ROW_EMU`), и офлайн-юнит требует, чтобы число
     * равнялось их частному. Прежние двенадцать строк на листе не были
     * измерены ничем — и держались на обрубленной по 62 знакам ссылке и на
     * странице, нарисованной мимо поля, которую растровая проверка тогда не
     * видела.
     *
     * **Это число — сид первого, чернового построения, а не ответ на вопрос
     * «сколько строк на листе».** Ответ даёт мера рендерера: черновая дека
     * меряется, и раскрой по настоящим высотам строк приезжает в построитель
     * (`measured-table-fit.ts`). Сид работает там, где меры не спрашивали, —
     * офлайн-сборка и рендерер прошлой версии. Худшая законная строка почти не
     * встречается: медиана строки таблицы выдачи прогона 91 — 350 520 EMU
     * против объявленных 1 036 320, и лист оставался пустым больше чем
     * наполовину. Раскрой это число не читает; пользоваться им после меры
     * значит вернуть сегодняшний дефект в новой одежде.
     */
    maxTableRowsPerSlide: Math.floor(SERP_TABLE_ROW_BUDGET_EMU / SERP_TABLE_WORST_ROW_EMU),
    layout: layout("table", { itemCharBudget: 110 }),
  },
  /*
   * Вторая таблица выдачи: что нашлось по дополнительным запросам.
   *
   * Отдельный шаблон, а не вариант `serp-table`, потому что у неё другие
   * колонки и другой смысл номера строки: **номера у неё нет вовсе**. Слить их
   * в один шаблон значило бы держать в реестре состав, который зависит от
   * данных, — и первый же читатель прочитал бы «Ссылка» как «№».
   */
  "serp-extra-queries": {
    templateId: "serp-extra-queries",
    rendererTemplate: "orion_golden_search_table",
    /*
     * Колонки перечислены здесь литералами — как и у первой таблицы. Реестр не
     * импортирует построители (это был бы цикл), поэтому состав повторён, а
     * связь держит юнит: расхождение реестра с построителем рендерер молча
     * проглотит, обрезав `headers[:5]`.
     */
    staticBlocks: [
      "Найдено по дополнительным запросам",
      "Ссылка",
      "Заголовок",
      "Найдено по запросу",
      "Тип источника",
      "Оценка",
    ],
    legend: [
      OTHER_SUBJECT_LABEL,
      UNCONFIRMED_SUBJECT_LABEL,
      RED_MARKER_LABEL,
      "Вероятно",
      UNVERIFIED_LABEL,
      "Нейтральный",
    ],
    methodologyNote:
      "Строки этой таблицы найдены не по имени, а другими запросами прогона, и в таблице по имени их нет. Мест в выдаче здесь не показано: у второго запроса своя нумерация, и сопоставлять её с первой нельзя.",
    maxBulletsPerSlide: 0,
    maxTableRowsPerSlide: Math.floor(SERP_TABLE_ROW_BUDGET_EMU / SERP_EXTRA_TABLE_WORST_ROW_EMU),
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
  /*
   * Страница фактической проверки Википедии.
   *
   * Отдельная запись, а не переиспользование `wikipedia-knowledge`: тот же
   * шаблон обслуживает панель знаний (p18), у которой есть визуал, и
   * перепрофилировать его нельзя. Макет — карточный, как у пустого состояния:
   * статус проверки, строки выдачи, рекомендация и футнот методологии. Так
   * методология печатается во всех состояниях страницы — полями, а не удачей
   * длины текста: прозаический макет вливал нарратив в буллет, и на живом
   * прогоне он исчез целиком.
   */
  "wikipedia-check": {
    templateId: "wikipedia-check",
    rendererTemplate: "orion_golden_wikipedia_check",
    staticBlocks: ["Результат проверки", "Строки выдачи", "Что проверить"],
    methodologyNote:
      "Наличие статьи проверяется прямым запросом к официальному API Википедии в каждом языковом разделе; строки поисковой выдачи приводятся отдельно от результата проверки.",
    /*
     * Сид: первая страница несёт карточку статуса, карточку рекомендации и
     * футнот методологии, и строк выдачи под ними помещается около четырёх.
     * Точное число называет мера рендерера — переполнение уходит в
     * продолжение, а не в телеметрию.
     */
    maxBulletsPerSlide: 4,
    maxBulletsPerContinuation: 10,
    maxTableRowsPerSlide: 0,
    layout: layout("single-column", {
      // Ёмкость карточки абзаца — одна на все страницы этой ветки; замер и
      // рецепт его повторения стоят при самой константе.
      narrativeCharBudget: CARD_NARRATIVE_CHAR_BUDGET,
      itemCharBudget: 400,
      // Замер: на базовом листе помещается один блок в 250–330 знаков.
      maxBulletCharsPerSlide: 340,
    }),
  },
  "ai-overview": {
    templateId: "ai-overview",
    rendererTemplate: "orion_golden_surface_panel",
    staticBlocks: ["AI-ответы поисковых систем", ...FINDING_BLOCKS],
    // Обещание держится данными: текст ответа едет наблюдением и печатается
    // блоками, а перенос делают продолжения. Про иллюстрацию сказано «если
    // она есть»: та же заметка стоит на страницах без панели.
    methodologyNote:
      "Ответы AI-сервисов приводятся полностью, без сокращений; иллюстрация панели, если она приведена, показывает только начало ответа. Интерпретация даётся отдельным блоком.",
    maxBulletsPerSlide: 6,
    // Первый лист делит левую колонку с панелью, поэтому его ёмкость —
    // знаками, а не числом блоков; продолжение — три блока: кусок ответа до
    // 1000 знаков и две строки источников.
    maxBulletsPerContinuation: 3,
    maxTableRowsPerSlide: 0,
    layout: layout("single-column", {
      /*
       * Тело ответа режется по границам предложений на куски не длиннее
       * ёмкости первого листа: кусок, который в него не помещается, разбивка
       * поделить не может, и он уезжал бы на лист целиком — сверх меры.
       */
      itemCharBudget: 1000,
      pagination: "continuation",
      /*
       * Первый лист печатает тела в **левой колонке** (62 % полосы) под
       * панелью: справа стоит сайдбар полной высоты. В узкой колонке строка
       * держит ~95 знаков против ~150 во всю ширину, и прежние 1600 знаков
       * рендерер терял. Остаток перекладывает мера рендерера
       * (`runDeckBuildMeasured`), а продолжение печатает тела во всю ширину.
       */
      maxBulletCharsPerSlide: 1000,
    }),
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
  /*
   * Лист «Кого проверяли» — собственная страница ответа на вопрос «чей это
   * профиль».
   *
   * Раскладка переиспользуется целиком (`orion_golden_no_data_compact`):
   * карточка статуса, карточка «что это означает», карточка рекомендации и
   * сноска метода. Рендерер не трогается — это условие работы, а не удобство:
   * новая ручка означала бы окно деплоя.
   *
   * Ёмкость абзаца — та же, что у страницы проверки: раскладка одна и та же
   * карточка (`_render_status_cards` → `content_card` с теми же
   * `min_h/max_h/padding/title_size`), и замер с заголовком «Статус сбора»
   * даёт те же 1016 знаков. Прежде здесь стояли 1113, выведенные из телеметрии
   * соседней страницы: абзац длиной 1017…1113 проходил все сверки и молча
   * терял хвост. Худший законный вход блока — 445 знаков, то есть до потолка
   * далеко, но потолок обязан ошибаться в сторону запрета.
   */
  "persona-check": {
    templateId: "persona-check",
    rendererTemplate: "orion_golden_no_data_compact",
    staticBlocks: ["Кого проверяли", "Что это означает", "Что проверить"],
    /*
     * Сноска печатается на всех состояниях листа, поэтому говорит только о
     * методе. Обещание «карточку можно открыть по указанному адресу» стояло
     * здесь и было ложью на трёх состояниях из четырёх: без решения и при
     * «различимой персоны нет» ни карточки, ни адреса не существует, а лист
     * прямо над сноской говорит об этом. Утверждение, у которого нет
     * наблюдения, переехало в `sourceNote` слайда — туда, где оно верно.
     */
    methodologyNote:
      "Персону субъекта выбирает оператор до начала сбора по карточкам внешних источников; на этом листе напечатано принятое решение либо его отсутствие.",
    maxBulletsPerSlide: 4,
    maxTableRowsPerSlide: 0,
    layout: layout("single-column", {
      narrativeCharBudget: CARD_NARRATIVE_CHAR_BUDGET,
      pagination: "none",
    }),
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

/**
 * Есть ли у этого макета рендерера список.
 *
 * Ответ уже записан ёмкостью: ноль означает «списка на странице нет». Спрашивают
 * по имени макета рендерера, потому что дальше сборки деки шаблон известен
 * только им; один макет обслуживает несколько шаблонов (`orion_golden_surface_panel`
 * — три), и список есть, если он есть хоть у одного из них.
 *
 * Незнакомый макет — «список есть»: молча выбросить содержимое хуже, чем
 * провезти лишнее поле.
 */
export function rendererTemplateHasBulletList(rendererTemplate: string): boolean {
  const declared = Object.values(DECK_TEMPLATE_REGISTRY).filter(
    (t) => t.rendererTemplate === rendererTemplate
  );
  return declared.length === 0 || declared.some((t) => t.maxBulletsPerSlide > 0);
}

/**
 * Макеты, у которых список на листе есть, но клиентской строки в нём нет.
 *
 * У дашборда метрик «список» — это плитки KPI и карточки тем, у сводного —
 * карточки находок; ни строки источников, ни статусной строки среди них не
 * рисует ни одна ветка рендерера, и маппинг нагрузки их туда не кладёт
 * (`bullets` дашборда — это `keyFindings`). Строка, построенная для такого
 * листа, умирала молча: восемь страниц дашборда метрик и одна сводная на
 * эталоне-72.
 *
 * Решение владельца: поле не строить там, где его негде напечатать. Ни одна
 * напечатанная страница от этого не меняется.
 */
const DASHBOARDS_WITHOUT_SOURCE_LINE: ReadonlySet<string> = new Set([
  "orion_golden_metrics_dashboard",
  "orion_golden_executive_dashboard",
]);

/**
 * Доедет ли строка «Источники» до листа этого макета.
 *
 * Ответ один и живёт здесь, рядом с ёмкостью списка, из которой он и выведен:
 * ноль в `maxBulletsPerSlide` означает «списка на странице нет», а строка
 * источников едет именно потоком списка (либо своим полем у карточных
 * макетов). Второй ответ на этот вопрос был бы третьей декларацией «что
 * печатает шаблон» — их и так две, рендерер и реестр.
 */
export function rendererTemplateCarriesSourceNote(rendererTemplate: string): boolean {
  return (
    rendererTemplateHasBulletList(rendererTemplate) &&
    !DASHBOARDS_WITHOUT_SOURCE_LINE.has(rendererTemplate)
  );
}

/**
 * Доедет ли статусная строка до листа этого макета.
 *
 * Спрашивается **отдельно** и по той же схеме: у дашборда метрик носитель у
 * неё свой (поле `statusNote` в нагрузке), у сводного дашборда нет ни поля, ни
 * потока буллетов — его «список» рисуется карточками находок. Пока обе строки
 * снимал один предикат «есть ли у макета список», статусная строка проезжала
 * на сводный дашборд по `maxBulletsPerSlide: 8` и роняла сборку сторожем
 * носителя. Асимметрия предикатов — ровно то, ради устранения чего снятие и
 * заводилось.
 */
export function rendererTemplateCarriesStatusNote(rendererTemplate: string): boolean {
  return (
    rendererTemplateHasBulletList(rendererTemplate) &&
    rendererTemplate !== "orion_golden_executive_dashboard"
  );
}
