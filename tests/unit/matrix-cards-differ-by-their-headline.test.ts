import { describe, expect, it } from "vitest";
import { printedBlocksForRepeatCheck } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";

/**
 * Две карточки матрицы рисков с одинаковым телом — не «текст напечатан дважды».
 *
 * Прогон DPA-2026-0053 встал на `p04_risk_dashboard__cont1`: у двух тем с
 * неподтверждённой принадлежностью тело карточки совпадает дословно —
 * «Всего по теме: 3 материала» плюс постоянная оговорка. Заголовок карточки —
 * сама тема — в буллет намеренно не входит (он уже напечатан строкой таблицы),
 * поэтому проверка сравнивала половину карточки и объявляла повтором две
 * разные.
 *
 * Единица, которую видит клиент на карточной странице, — заголовок вместе с
 * телом. По ней и сравнивается.
 */

const BODY =
  "Всего по теме: 3 материала\nДо уточнения идентификации материал не включён в итог «об этом лице».";

const card = (themes: string[], bullets: string[]) => ({
  narrative: undefined,
  bullets,
  sourceNote: undefined,
  table: { headers: ["Тема", "Уровень", "Приоритет", "Идентификатор"], rows: themes.map((t) => [t, "низкий", "—", "—"]) },
});

describe("повтор на карточной странице", () => {
  it("одинаковое тело под разными темами повтором не считается", () => {
    const blocks = printedBlocksForRepeatCheck(
      card(["Деловой профиль", "Биографические сведения"], [BODY, BODY]),
      "risk-matrix"
    );
    expect(new Set(blocks.map((b) => b.key)).size).toBe(2);
  });

  it("одинаковое тело под одной темой — повтор, как и было", () => {
    const blocks = printedBlocksForRepeatCheck(
      card(["Деловой профиль", "Деловой профиль"], [BODY, BODY]),
      "risk-matrix"
    );
    expect(new Set(blocks.map((b) => b.key)).size).toBe(1);
  });

  it("страница без карточек сравнивается как прежде — по самому тексту", () => {
    const blocks = printedBlocksForRepeatCheck(
      { narrative: BODY, bullets: [BODY], sourceNote: undefined, table: undefined },
      "finding-cards"
    );
    expect(new Set(blocks.map((b) => b.key)).size).toBe(1);
  });

  it("таблица не по числу карточек к заголовкам не привязывается", () => {
    // Строк три, буллета два — что чей заголовок, неизвестно, и выдумывать
    // соответствие нельзя.
    const blocks = printedBlocksForRepeatCheck(
      {
        narrative: undefined,
        bullets: [BODY, BODY],
        sourceNote: undefined,
        table: { rows: [["A"], ["B"], ["C"]] },
      },
      "risk-matrix"
    );
    expect(new Set(blocks.map((b) => b.key)).size).toBe(1);
  });

  it("послабление дано только карточкам матрицы, а не любой таблице", () => {
    // У другого шаблона строка таблицы не заголовок карточки, и связывать её
    // с буллетом нельзя: повтор остаётся повтором.
    const blocks = printedBlocksForRepeatCheck(
      {
        narrative: undefined,
        bullets: [BODY, BODY],
        sourceNote: undefined,
        table: { rows: [["A"], ["B"]] },
      },
      "finding-cards"
    );
    expect(new Set(blocks.map((b) => b.key)).size).toBe(1);
  });

  it("пустой после нормализации блок в сравнение не идёт", () => {
    const blocks = printedBlocksForRepeatCheck(
      { narrative: "—", bullets: ["…"], sourceNote: undefined, table: undefined },
      "finding-cards"
    );
    expect(blocks).toEqual([]);
  });
});
