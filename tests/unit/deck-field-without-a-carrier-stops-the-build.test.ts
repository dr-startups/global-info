/**
 * Поле деки, у которого в нагрузке нет носителя, роняет сборку и называет себя.
 *
 * Потеря `sourceNote` и `statusNote` живёт **в маппинге нагрузки**, а не в
 * рендерере: у `orion_golden_search_table` в реестре `maxBulletsPerSlide: 0`,
 * то есть носителя нет ни одного, и построенная сноска умирает молча. Ворот
 * приёмки «каждое поле доехало до листа» этого не видит по построению — он
 * читает нагрузку, а поле, до неё не доехавшее, для него не существует: на
 * эталоне-72 он зелёный при 21 потерянной сноске.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clientTextWithoutCarrier,
  toRendererPayload,
} from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { ReportDeckManifest } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const EMPTY_MANIFEST = { toc: [], sectionPageRanges: [] } as unknown as ReportDeckManifest;

function slide(over: Partial<RendererSlide>): RendererSlide {
  return {
    slideKey: "p09_ru_serp_table",
    sectionKey: "RU_PROFILE",
    template: "orion_golden_search_table",
    templateId: "serp-table",
    title: "Россия — Яндекс, позиции 1–20",
    pageNumber: 16,
    totalPageCount: 48,
    baseSlotId: "p09_ru_serp_table",
    isContinuation: false,
    table: {
      headers: ["№", "Ссылка", "Заголовок", "Тип источника", "Оценка"],
      rows: [["1", "example.ru", "Заголовок материала", "Новостное СМИ", "Нейтральный"]],
    },
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
    ...over,
  };
}

function build(slides: RendererSlide[]): unknown {
  return toRendererPayload({
    deckManifest: EMPTY_MANIFEST,
    rendererSlides: slides,
    subjectName: "Умар Кремлёв",
  });
}

describe("клиентское поле деки без носителя в нагрузке", () => {
  it("роняет сборку и называет слайд и поле", () => {
    const withNote = slide({ sourceNote: "Источники — forbes.ru, tass.ru и ещё 7." });
    let message = "";
    try {
      build([withNote]);
    } catch (err) {
      message = String((err as Error).message ?? "");
    }
    expect(message).toContain("p09_ru_serp_table");
    expect(message).toContain("sourceNote");
  });

  it("тот же слайд без сноски проходит", () => {
    expect(() => build([slide({})])).not.toThrow();
  });

  it("носителем не считается лист соседнего слайда", () => {
    const STATUS = "Тема подтверждена, уровень внимания — высокий; оценка достоверна.";
    const table = slide({ statusNote: STATUS });
    const neighbour: RendererSlide = {
      ...slide({}),
      slideKey: "p19_ru_knowledge_2",
      template: "orion_golden_prose",
      templateId: "ai-overview",
      table: undefined,
      bullets: [STATUS],
    };
    let message = "";
    try {
      build([table, neighbour]);
    } catch (err) {
      message = String((err as Error).message ?? "");
    }
    expect(message).toContain("p09_ru_serp_table");
    expect(message).toContain("statusNote");
  });

  it("дека без единого проверенного поля — тоже отказ", () => {
    // Пропуск, похожий на проход: ворот, которому нечего было проверять,
    // печатает «0 провалено» ровно так же, как ворот, проверивший всё.
    const silent = slide({ title: "" });
    expect(() => build([silent])).toThrow();
  });

  it("исключения сторожа не шире своих причин", () => {
    /*
     * Исключение — это решение «клиент этого текста не увидит», и оно обязано
     * быть ровно там, где решение принято. Методичка макета не доезжает до
     * листа **везде, кроме карточных макетов**: там у неё своё поле, и там её
     * пропажу надо ловить. Абзац разделителя региона не доезжает у варианта по
     * умолчанию, а у `hero` — доезжает.
     */
    const pair = (deck: Partial<RendererSlide>, payload: Record<string, unknown>) => [
      { deck: { ...slide({}), ...deck } as RendererSlide, payload },
    ];
    const METHODOLOGY = "Методология страницы — каркасный текст шаблона.";
    const LEAD = "Раздел показывает, что увидит банк, инвестор или контрагент в выдаче.";

    const proseSkipped = clientTextWithoutCarrier(
      pair(
        { template: "orion_golden_prose", methodologyNote: METHODOLOGY },
        { slideKey: "p09_ru_serp_table", template: "orion_golden_prose", title: "Заголовок" }
      )
    );
    expect(proseSkipped.missing.map((m) => m.field)).not.toContain("methodologyNote");

    const cardChecked = clientTextWithoutCarrier(
      pair(
        { template: "orion_golden_wikipedia_check", methodologyNote: METHODOLOGY },
        { slideKey: "p09_ru_serp_table", template: "orion_golden_wikipedia_check", title: "Заголовок" }
      )
    );
    expect(cardChecked.missing.map((m) => m.field)).toContain("methodologyNote");

    const dividerDefault = clientTextWithoutCarrier(
      pair(
        { template: "orion_golden_region_divider", narrative: LEAD },
        { slideKey: "p09_ru_serp_table", template: "orion_golden_region_divider", title: "Заголовок" }
      )
    );
    expect(dividerDefault.missing.map((m) => m.field)).not.toContain("narrative");

    const dividerHero = clientTextWithoutCarrier(
      pair(
        { template: "orion_golden_region_divider", layoutVariant: "hero", narrative: LEAD },
        {
          slideKey: "p09_ru_serp_table",
          template: "orion_golden_region_divider",
          layoutVariant: "hero",
          title: "Заголовок",
        }
      )
    );
    expect(dividerHero.missing.map((m) => m.field)).toContain("narrative");
  });

  it("дека эталона-72 отказа не даёт", () => {
    const root = join(process.cwd(), "baselines/report-72/artifacts/deck-sections");
    const deck = JSON.parse(readFileSync(join(root, "assembled-deck.json"), "utf8")) as {
      slides: RendererSlide[];
    };
    const manifest = JSON.parse(
      readFileSync(join(root, "report-deck-manifest.json"), "utf8")
    ) as ReportDeckManifest;
    const assets = JSON.parse(
      readFileSync(join(root, "report-assets.fixture.json"), "utf8")
    ) as Array<{ assetRef: string }>;
    expect(() =>
      toRendererPayload({
        deckManifest: manifest,
        rendererSlides: deck.slides,
        subjectName: "Умар Кремлёв",
        assets,
      })
    ).not.toThrow();
  });
});
