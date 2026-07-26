import { describe, it, expect } from "vitest";
import {
  parseYandexModTime,
  parseSerperDate,
  publishedAtOf,
  toDisplayDate,
} from "../../src/modules/digital-profile/providers/published-date";

/**
 * Шаг 05.2(а) плана.
 *
 * Дата публикации приходила от обоих провайдеров и выбрасывалась: Яндекс
 * отдаёт <modtime> внутри сырого XML документа, Serper — человекочитаемую
 * строку. Для due diligence «когда» обязательно: материал 2014 года и
 * материал 2024 года весят по-разному.
 */

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("parseYandexModTime", () => {
  it("разбирает modtime из блока документа", () => {
    const block = "<doc><url>https://x.ru</url><modtime>20240826T183701</modtime></doc>";
    expect(parseYandexModTime(block, NOW)).toBe("2024-08-26T18:37:01.000Z");
  });

  it("возвращает null, когда modtime отсутствует", () => {
    expect(parseYandexModTime("<doc><url>https://x.ru</url></doc>", NOW)).toBeNull();
  });

  it("отбрасывает неправдоподобные даты", () => {
    expect(parseYandexModTime("<modtime>19700101T000000</modtime>", NOW)).toBeNull();
    expect(parseYandexModTime("<modtime>20990101T000000</modtime>", NOW)).toBeNull();
  });

  it("не падает на мусоре", () => {
    expect(parseYandexModTime("<modtime>не дата</modtime>", NOW)).toBeNull();
    expect(parseYandexModTime("", NOW)).toBeNull();
  });
});

describe("parseSerperDate", () => {
  it("разбирает форму «Mon DD, YYYY»", () => {
    expect(parseSerperDate("Aug 25, 2024", NOW)).toBe("2024-08-25T00:00:00.000Z");
    expect(parseSerperDate("Mar 17, 2025", NOW)).toBe("2025-03-17T00:00:00.000Z");
  });

  it("разбирает форму «DD Mon YYYY» и «Mon YYYY»", () => {
    expect(parseSerperDate("17 Mar 2025", NOW)).toBe("2025-03-17T00:00:00.000Z");
    expect(parseSerperDate("Mar 2025", NOW)).toBe("2025-03-01T00:00:00.000Z");
  });

  it("разбирает относительные даты от заданного момента", () => {
    expect(parseSerperDate("2 days ago", NOW)).toBe("2026-07-22T12:00:00.000Z");
    expect(parseSerperDate("1 year ago", NOW)).toBe("2025-07-24T12:00:00.000Z");
  });

  it("принимает ISO", () => {
    expect(parseSerperDate("2024-08-25", NOW)).toBe("2024-08-25T00:00:00.000Z");
  });

  it("возвращает null вместо догадки на неизвестном формате", () => {
    expect(parseSerperDate("недавно", NOW)).toBeNull();
    expect(parseSerperDate("Foo 12, 2024", NOW)).toBeNull();
    expect(parseSerperDate("", NOW)).toBeNull();
    expect(parseSerperDate(undefined, NOW)).toBeNull();
  });

  it("не принимает дату из будущего", () => {
    expect(parseSerperDate("Jan 1, 2030", NOW)).toBeNull();
  });
});

describe("publishedAtOf", () => {
  it("предпочитает нормализованное поле", () => {
    expect(publishedAtOf({ publishedAt: "2024-08-25T00:00:00.000Z" }, NOW)).toBe(
      "2024-08-25T00:00:00.000Z"
    );
  });

  it("восстанавливает дату из строки Serper в ранее сохранённых строках", () => {
    expect(publishedAtOf({ source: "serper", date: "Aug 25, 2024" }, NOW)).toBe(
      "2024-08-25T00:00:00.000Z"
    );
  });

  it("восстанавливает дату из сырого XML Яндекса в ранее сохранённых строках", () => {
    const raw = "<doc><modtime>20201124T004032</modtime></doc>";
    expect(publishedAtOf({ provider: "YANDEX", raw }, NOW)).toBe("2020-11-24T00:40:32.000Z");
  });

  it("возвращает null, когда даты нет нигде", () => {
    expect(publishedAtOf({ provider: "GOOGLE", position: 3 }, NOW)).toBeNull();
    expect(publishedAtOf(null, NOW)).toBeNull();
    expect(publishedAtOf("строка", NOW)).toBeNull();
  });
});

describe("toDisplayDate", () => {
  it("сводит ISO к YYYY-MM-DD", () => {
    expect(toDisplayDate("2024-08-26T18:37:01.000Z")).toBe("2024-08-26");
  });

  it("возвращает null на пустом и некорректном значении", () => {
    expect(toDisplayDate(null)).toBeNull();
    expect(toDisplayDate(undefined)).toBeNull();
    expect(toDisplayDate("не дата")).toBeNull();
  });
});
