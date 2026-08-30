/**
 * Строка таблицы выдачи не печатает свой адрес дважды.
 *
 * Адрес в поле заголовка кладём **мы сами**: адаптер Arsenkin честно пишет
 * `null`, когда карта сниппетов заголовка не содержит
 * (`adapters/check-top.ts`), а `canonical-report-prepare.ts` подставляет
 * `title: text || obs.title || obs.url || obs.key`. Дальше печатник видит
 * непустой заголовок, и запасное «(без заголовка)» не срабатывает: оно ждёт
 * `undefined`.
 *
 * Замер эталона-72: шесть строк из 46 несущих полосу адреса печатали свой
 * собственный адрес в колонке «Заголовок», и он же стоял полосой под строкой.
 * У первой из них сработал ещё и наш рез: клиент читал обрезанный адрес сверху
 * и полный снизу.
 *
 * Свойство: у печатника один предикат «отдал ли поисковик заголовок», и
 * сравнивает он печать заголовка адресом с печатью адреса строки — существующим
 * `clientAddress`, а не новой нормализацией.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_TITLE_NOT_GIVEN,
  serpRowTitleCell,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import { blockingIssues } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import { rowsPrintingTheirOwnAddress } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";

describe("ячейка «Заголовок» не повторяет адрес строки", () => {
  it.each([
    ["https://www.techcult.ru/promo/15800-biografiya", "https://www.techcult.ru/promo/15800-biografiya"],
    ["http://labyrinth.ru/content/card.asp?cardid=92628", "http://labyrinth.ru/content/card.asp?cardid=92628"],
    ["https://moskva.bezformata.com/listnews/sergey-glinka/148682615/", "https://moskva.bezformata.com/listnews/sergey-glinka/148682615/"],
    ["https://www.utro.ru/release/1563439.shtml", "https://utro.ru/release/1563439.shtml"],
    ["https://x.com/rucriminalinfo/status/2008361452998914141?lang=ru", "https://x.com/rucriminalinfo/status/2008361452998914141?lang=ru"],
    ["https://rupep.org/ru/person/8095/", "https://rupep.org/ru/person/8095"],
  ])("заголовок %j при адресе %j считается неотданным", (title, url) => {
    expect(serpRowTitleCell(title, url)).toBe(SERP_TITLE_NOT_GIVEN);
  });

  it("настоящий заголовок печатается без изменений", () => {
    const title = "ГЛИНКА Сергей Михайлович - Биография";
    expect(serpRowTitleCell(title, "https://labyrinth.ru/content/card.asp?cardid=92628")).toBe(title);
  });

  it("заголовок в 96 знаков режется нашим резом, а не подменяется словами", () => {
    const title = "а".repeat(96);
    const cell = serpRowTitleCell(title, "https://example.ru/a");
    expect(cell).not.toBe(SERP_TITLE_NOT_GIVEN);
    expect(cell.length).toBeLessThanOrEqual(95);
    expect(cell.endsWith("…")).toBe(true);
  });

  it("заголовок с чужим адресом внутри остаётся заголовком", () => {
    // Другой факт: поисковик заголовок отдал, просто в нём стоит ссылка.
    const title = "https://t.me/rucriminalinfo 18 февраля в Московской области";
    expect(serpRowTitleCell(title, "https://x.com/rucriminalinfo/status/2008361452998914141")).toBe(
      title
    );
  });

  it.each([undefined, "", "   "])("заголовок %j даёт ту же формулировку", (title) => {
    // У печатника один ответ: две разные заглушки в одной таблице читаются как
    // два разных факта.
    expect(serpRowTitleCell(title, "https://example.ru/a")).toBe(SERP_TITLE_NOT_GIVEN);
  });
});

describe("ворот «строка не печатает свой адрес дважды»", () => {
  const table = (rows: string[][], addresses: string[]) => ({
    slideKey: "p09_ru_serp_table__cont6",
    table: { headers: ["№", "Заголовок", "Тип источника", "Оценка"], rows, rowAddresses: addresses },
  });

  it("строка с адресом в ячейке названа слайдом и номером", () => {
    const found = rowsPrintingTheirOwnAddress([
      table(
        [
          ["9", "https://www.techcult.ru/promo/15800", "—", "Не проверено"],
          ["10", "ГЛИНКА Сергей Михайлович - Биография", "—", "Не проверено"],
        ],
        ["techcult.ru/promo/15800", "labyrinth.ru/content/card.asp?cardid=92628"]
      ),
    ]);
    expect(found).toEqual([{ slideKey: "p09_ru_serp_table__cont6", row: 1 }]);
  });

  it("обрезанный нашим резом адрес ворот тоже видит", () => {
    // Ровно первая из шести строк эталона: сверху обрезанный адрес, снизу полный.
    const found = rowsPrintingTheirOwnAddress([
      table(
        [["9", "https://www.techcult.ru/promo/15800-biografiya-biznesmena…", "—", "Не проверено"]],
        ["techcult.ru/promo/15800-biografiya-biznesmena-sergeya-glinki-i-novye-proekty"]
      ),
    ]);
    expect(found).toHaveLength(1);
  });

  it("чужой адрес в ячейке ворот не роняет", () => {
    const found = rowsPrintingTheirOwnAddress([
      table(
        [["9", "https://t.me/rucriminalinfo 18 февраля", "—", "Не проверено"]],
        ["x.com/rucriminalinfo/status/2008361452998914141"]
      ),
    ]);
    expect(found).toEqual([]);
  });

  it("блокирует с первой же строки", () => {
    const issues = blockingIssues({
      quoteDefectSlides: new Set(),
      codeSlides: new Set(),
      ownAddressRowSlides: new Set(["p09_ru_serp_table__cont6"]),
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("p09_ru_serp_table__cont6");
    expect(issues[0]).toMatch(/адрес/iu);
  });

  it("здоровая дека ворот не роняет", () => {
    expect(
      blockingIssues({ quoteDefectSlides: new Set(), codeSlides: new Set(), ownAddressRowSlides: new Set() })
    ).toEqual([]);
  });
});
