import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  clientVisibleStrings,
  findInternalCodes,
  scanDeckForInternalCodes,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/internal-code-scan";

/**
 * Шаг 07.8.
 *
 * В деке контрольного прогона на странице профиля стояло: «Визуальный экспорт
 * страницы недоступен (VISUAL_ASSET_UNAVAILABLE)». Отчёт читает человек, а не
 * оператор системы: техническая константа в скобках не сообщает ему ничего и
 * подрывает доверие ко всему документу.
 */

describe("внутренний код отличается от обычного текста", () => {
  it("узнаёт код проекта", () => {
    expect(findInternalCodes("недоступен (VISUAL_ASSET_UNAVAILABLE); текст")).toEqual([
      "VISUAL_ASSET_UNAVAILABLE",
    ]);
    expect(findInternalCodes("PRE_RENDER_DATA_GATE_FAILED")).toEqual([
      "PRE_RENDER_DATA_GATE_FAILED",
    ]);
  });

  it("аббревиатуры due diligence кодами не считает", () => {
    // Иначе правило вычистило бы законные слова из отчёта о комплаенсе.
    expect(findInternalCodes("Категория PEP влияет на уровень контроля")).toEqual([]);
    expect(findInternalCodes("Список OFAC SDN, проверка KYC, номер ОГРНИП")).toEqual([]);
    expect(findInternalCodes("Компания ООО «ТЕЛЕГРАМ»")).toEqual([]);
  });

  it("повтор одного кода перечисляется один раз", () => {
    expect(findInternalCodes("A_B и снова A_B")).toEqual(["A_B"]);
  });

  it("пустое не роняет", () => {
    expect(findInternalCodes("")).toEqual([]);
    expect(findInternalCodes(null)).toEqual([]);
  });
});

describe("клиентский текст слайда", () => {
  it("собирается из всех полей, которые видит читатель", () => {
    const strings = clientVisibleStrings({
      slideKey: "s1",
      title: "Заголовок",
      narrative: "Проза",
      staticBlocks: [{ heading: "Врезка", lines: ["Строка"] }],
      table: { headers: ["Домен"], rows: [["kommersant.ru"]] },
    });
    expect(strings).toEqual(
      expect.arrayContaining(["Заголовок", "Проза", "Врезка", "Строка", "Домен", "kommersant.ru"])
    );
  });

  it("пустые строки не попадают", () => {
    expect(clientVisibleStrings({ title: "  ", narrative: "Текст" })).toEqual(["Текст"]);
  });
});

describe("проверка деки", () => {
  it("называет слайд и код", () => {
    expect(
      scanDeckForInternalCodes([
        { slideKey: "p35_lexis_visual", narrative: "недоступен (VISUAL_ASSET_UNAVAILABLE)" },
      ])
    ).toEqual([{ slide: "p35_lexis_visual", code: "VISUAL_ASSET_UNAVAILABLE" }]);
  });

  it("чистая дека даёт пустой список", () => {
    expect(
      scanDeckForInternalCodes([{ slideKey: "s1", narrative: "Обычный клиентский текст." }])
    ).toEqual([]);
  });

  it("ловит код в настоящих слайдах, а не только в придуманной строке", () => {
    // Отрицательный контроль: слайды report-72 в том виде, в каком их выдавал
    // код до исправления 07.8. Фикстура заморожена отдельно и намеренно.
    //
    // Прежде контролем служил `assembled-deck.json` — он же эталон текущей
    // сборки. Один файл отвечал на два вопроса: «что код делает сейчас» и
    // «что он делал до исправления». Стоило пересобрать эталон, и код из него
    // исчезал — вместе с проверкой, которая должна была этот код ловить.
    // Правило проекта: один вопрос — один ответ, поэтому контроль живёт своим
    // файлом и обновляться вместе с эталоном не может.
    const deck = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/deck-with-internal-codes.json"), "utf8")
    ) as { slides: Array<Record<string, unknown>> };
    expect(deck.slides.length).toBeGreaterThan(0);
    const found = scanDeckForInternalCodes(deck.slides);
    expect(found.map((f) => f.code)).toContain("VISUAL_ASSET_UNAVAILABLE");
  });

  it("текущий эталон сборки внутренних кодов не содержит", () => {
    // Обратная сторона той же проверки: то, что код выдаёт сегодня, обязано
    // быть чистым. Раньше этого никто не проверял — эталон был обязан код
    // содержать, и «грязно» было нормой.
    const deck = JSON.parse(
      readFileSync(
        join(process.cwd(), "baselines/report-72/artifacts/deck-sections/assembled-deck.json"),
        "utf8"
      )
    ) as { slides: Array<Record<string, unknown>> };
    expect(scanDeckForInternalCodes(deck.slides)).toEqual([]);
  });
});
