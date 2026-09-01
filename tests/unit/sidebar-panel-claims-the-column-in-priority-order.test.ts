/**
 * Боковая панель отдаёт наружу столько, сколько держит её колонка, и отдаёт
 * это в порядке важности.
 *
 * До этой правки построитель клал в панель до 1420 знаков при колонке в 660 и
 * решение «что потерять» оставлял рендереру — тот резал снизу, то есть по
 * последнему блоку. Плюс рекомендацию съедала дедупликация: `whatIsVisible`
 * берётся из склеенного абзаца страницы, а тот последним блоком содержит сам
 * `whatToCheck`, — предложение помечалось сказанным и `recommendedActions`
 * выходил пустым на всех 16 панелях эталона-72.
 */

import { describe, expect, it } from "vitest";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { SIDEBAR_COLUMN_CHAR_BUDGET } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { ReportDeckManifest } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

/** Предложение ровно заданной длины: тест меряет бюджет, а не красоту текста. */
function sentence(head: string, length: number): string {
  let out = head;
  while (out.length < length - 1) out += " деталь";
  return `${out.slice(0, length - 1).trimEnd()}.`;
}

/** Поле из нескольких предложений — иначе жадный распределитель нечем кормить. */
function field(head: string, count: number, length: number): string {
  return Array.from({ length: count }, (_, i) => sentence(`${head} ${i + 1}`, length)).join(" ");
}

const FOUND = field("Найдено по этой поверхности, часть", 2, 145);
const NARRATIVE = field("Абзац страницы описывает картину, часть", 4, 125);
const WHY = field("Значимость для клиента, часть", 2, 145);
const STATUS = sentence("Статус проверки по этой странице", 140);
const CHECK = field("Проверить сайты-источники материалов, часть", 2, 129);
const EX1 = field("Первый материал выделен рамкой потому, часть", 2, 119);
const EX2 = field("Второй материал выделен рамкой потому, часть", 2, 119);

function panelSlide(over: Partial<RendererSlide> = {}): RendererSlide {
  return {
    slideKey: "p20_ru_related_1",
    sectionKey: "RU_PROFILE",
    template: "orion_golden_surface_panel",
    templateId: "related-queries",
    title: "Россия — связанные запросы",
    pageNumber: 30,
    totalPageCount: 48,
    baseSlotId: "p20_ru_related_1",
    isContinuation: false,
    narrative: NARRATIVE,
    bullets: [],
    evidenceRefs: ["inventory:obs-1"],
    findingIds: [],
    metrics: {},
    visualAssetRefs: ["related_panel_ru"],
    staticBlocks: [],
    whatWasFound: FOUND,
    whyItMatters: WHY,
    statusNote: STATUS,
    whatToCheck: CHECK,
    sourceNote: "Источники — example.ru.",
    ...over,
  };
}

function panelOf(slide: RendererSlide): Record<string, unknown> {
  const payload = toRendererPayload({
    deckManifest: { toc: [], sectionPageRanges: [] } as unknown as ReportDeckManifest,
    rendererSlides: [slide],
    subjectName: "Умар Кремлёв",
    assets: [{ assetRef: "related_panel_ru", kind: "visual", title: "Связанные запросы" }],
  });
  const manifest = payload.deckManifest as { finalSlides: Array<Record<string, unknown>> };
  const analysis = manifest.finalSlides[0]!.visualAnalysis;
  return (analysis ?? {}) as Record<string, unknown>;
}

function blockLengths(va: Record<string, unknown>): number {
  const explanations = (va.highlightExplanations ?? []) as Array<{ clientReason?: string }>;
  const actions = (va.recommendedActions ?? []) as string[];
  return (
    String(va.headlineConclusion ?? "").length +
    String(va.whatIsVisible ?? "").length +
    String(va.clientMeaning ?? "").length +
    actions.reduce((a, b) => a + String(b ?? "").length, 0) +
    explanations.reduce((a, e) => a + String(e?.clientReason ?? "").length, 0)
  );
}

describe("панель не отдаёт наружу больше, чем держит её колонка", () => {
  it("сумма блоков переполненной панели не превышает ёмкость колонки", () => {
    const va = panelOf(
      panelSlide({
        highlightExplanations: [
          { clientReason: EX1, frameTone: "red" },
          { clientReason: EX2, frameTone: "amber" },
        ],
      })
    );
    // Неправильный ответ — сумма пяти бюджетов полей: они объявлены потолками
    // читаемости, а ёмкостью колонки не являются ни по одному, ни в сумме.
    const sum = blockLengths(va);
    expect(SIDEBAR_COLUMN_CHAR_BUDGET, `сумма блоков панели — ${sum}`).toBeTypeOf("number");
    expect(sum).toBeLessThanOrEqual(SIDEBAR_COLUMN_CHAR_BUDGET);
  });

  it("на переполненной панели остаются и вывод, и рекомендация", () => {
    const va = panelOf(
      panelSlide({
        highlightExplanations: [
          { clientReason: EX1, frameTone: "red" },
          { clientReason: EX2, frameTone: "amber" },
        ],
      })
    );
    const actions = (va.recommendedActions ?? []) as string[];
    expect(String(va.headlineConclusion ?? "")).not.toBe("");
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.join(" ")).toContain(CHECK.slice(0, 40));
  });

  it("рекомендацию не съедает дедупликация склеенного абзаца", () => {
    /*
     * Вход эталона-72: `narrative` пуст, а поля находки коротки — склеенный
     * абзац страницы целиком помещается в потолок `whatIsVisible`, вместе с
     * последним своим блоком, самим `whatToCheck`. Предложение рекомендации
     * помечается сказанным раньше, чем до неё доходит очередь, и
     * `recommendedActions` выходит пустым: так на всех 16 панелях эталона.
     */
    const short = "Проверить сайты-источники выделенных изображений.";
    const va = panelOf(
      panelSlide({
        narrative: undefined,
        whatWasFound: "Найдено четыре изображения субъекта в выдаче.",
        whyItMatters: "Изображения формируют первое впечатление о персоне.",
        statusNote: undefined,
        whatToCheck: short,
      })
    );
    const actions = (va.recommendedActions ?? []) as string[];
    expect(actions).toEqual([short]);
  });

  it("рекомендация длиннее своего потолка берётся целыми предложениями", () => {
    const first = sentence("Проверить сайты-источники выделенных изображений", 150);
    const second = sentence("Затем подготовить позицию по каждому материалу", 200);
    const va = panelOf(panelSlide({ whatToCheck: `${first} ${second}` }));
    const actions = (va.recommendedActions ?? []) as string[];
    expect(actions).toEqual([first]);
  });

  it("блок берёт целые предложения или не берёт ничего", () => {
    // Вывод и рекомендация выбирают почти весь бюджет; на «Что это значит»
    // остаётся место под значимость, но не под статусную строку.
    const va = panelOf(
      panelSlide({
        whyItMatters: sentence("Значимость короткая", 90),
        statusNote: sentence("Статусная строка этой страницы длиннее остатка", 120),
      })
    );
    const meaning = String(va.clientMeaning ?? "");
    expect(meaning).toContain("Значимость короткая");
    expect(meaning).not.toContain("Статусная строка");
    // Огрызков панель не печатает: блок кончается точкой целого предложения.
    expect(meaning).toMatch(/\.$/u);
  });

  it("единственное предложение длиннее бюджета не превращается в обрубок", () => {
    const va = panelOf(
      panelSlide({
        whatWasFound: sentence("Единственное предложение вывода", 400),
        narrative: undefined,
        whyItMatters: undefined,
        statusNote: undefined,
      })
    );
    expect(String(va.headlineConclusion ?? "")).toBe("");
  });

  it("длинная сноска источников не уносит свой носитель", () => {
    /*
     * Подпись источников — одно предложение по построению, и снятие срезов
     * сделало его длиннее («и ещё 1» → «и ещё 182»). Правило «целые
     * предложения или ничего» к ней не применимо: предложение там одно, и
     * потеряв его, панель теряет носитель поля `sourceNote` — а сторож
     * носителя превращает это в отказ **всей сборки отчёта**.
     */
    const LONG_NOTE =
      "Источники — abudhabi-capital-news-daily.ae, khaleej-finance-post-review.ae, " +
      "stockholm-kuriren-business.se, nordmarket-watch-daily.se и ещё 180.";
    expect(LONG_NOTE.length).toBeGreaterThan(140);
    const va = panelOf(panelSlide({ sourceNote: LONG_NOTE }));
    expect(String(va.provenanceLabel ?? "")).toContain("abudhabi-capital-news-daily.ae");
    // И не едет целиком: полоса под панелью держит одну строку 9 pt, вторая
    // уходит чернилами за низ сцены.
    expect(String(va.provenanceLabel ?? "").length).toBeLessThanOrEqual(140);
  });

  it("пустой абзац страницы отдаёт средний блок методичке макета", () => {
    /*
     * Форма стр. 46 живого прогона: у страницы-продолжения своего абзаца нет,
     * есть только методичка макета. `??` смотрит на `null`, а `""` — не
     * `null`: панель выходила без единого блока, и сторож ронял сборку.
     */
    const va = panelOf(
      panelSlide({
        narrative: "",
        whatWasFound: undefined,
        whyItMatters: undefined,
        statusNote: undefined,
        whatToCheck: undefined,
        methodologyNote: "Подсказки отражают частотные запросы пользователей.",
      })
    );
    expect(String(va.whatIsVisible ?? "")).toContain("Подсказки отражают частотные запросы");
  });

  it("«Ещё N похожих сигналов» называет тех, кому не хватило места", () => {
    const explanations = [1, 2, 3, 4, 5].map((i) => ({
      clientReason: sentence(`Материал номер ${i} выделен рамкой потому`, 95),
      frameTone: "red" as const,
    }));
    const va = panelOf(panelSlide({ highlightExplanations: explanations }));
    const printed = (va.highlightExplanations ?? []) as Array<{ clientReason?: string }>;
    // Неправильный ответ — 3: остаток, посчитанный до распределения бюджета.
    expect(printed.length).toBe(1);
    expect(va.moreSignalsCount).toBe(4);
  });
});
