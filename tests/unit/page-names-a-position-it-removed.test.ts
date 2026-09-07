/**
 * Страница называет позицию, которую убрали мы, — и не сваливает это на выдачу.
 *
 * Номер строки таблицы — настоящее место в поисковой выдаче, поэтому снятая
 * строка оставляет свой номер незанятым: перенумеровать оставшиеся значило бы
 * соврать о выдаче. Молчать о дыре тоже нельзя — читатель считает её потерей
 * данных.
 *
 * Хуже всего было бы объяснить её прежней фразой: «Позицию 14 не вернул ни один
 * источник выдачи в этом прогоне» — источник её вернул, убрали её мы. Поэтому у
 * снятых позиций своя ветка, и она идёт раньше.
 *
 * Кто снял и почему, страница не говорит: пометок о правках аналитика в отчёте
 * нет вовсе (решение владельца 6).
 */

import { describe, expect, it } from "vitest";
import { serpRankGapSentences } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";

const base = {
  collected: [1, 2, 3, 14],
  occupied: [],
  datasetKnowsSecondReading: true,
  queryNamed: true,
  positional: true,
  topN: 3,
};

describe("проза таблицы о пропущенных номерах", () => {
  it("снятая позиция названа своей фразой", () => {
    const out = serpRankGapSentences({ ...base, printed: [1, 2], removed: [3] });
    expect(out.join(" ")).toContain("Позиция 3 в таблице не показана");
    expect(out.join(" ")).not.toContain("не вернул ни один источник");
  });

  it("несколько снятых — перечнем", () => {
    const out = serpRankGapSentences({ ...base, printed: [1], removed: [2, 3] });
    expect(out.join(" ")).toContain("Позиции 2–3 в таблице не показаны");
  });

  it("снятая позиция не смешивается с непришедшей", () => {
    const out = serpRankGapSentences({
      ...base,
      collected: [1, 3],
      printed: [1],
      removed: [3],
    }).join(" ");
    expect(out).toContain("Позиция 3 в таблице не показана");
    // Позиции 2 в собранных нет вовсе — о ней говорит прежняя фраза.
    expect(out).toContain("Позицию 2");
    expect(out).toContain("не вернул ни один источник");
  });

  it("без снятых прежние фразы не меняются", () => {
    const out = serpRankGapSentences({ ...base, printed: [1, 2] }).join(" ");
    expect(out).toContain("Позицию 3");
    expect(out).toContain("не вернул ни один источник");
    expect(out).not.toContain("в таблице не показана");
  });
});
