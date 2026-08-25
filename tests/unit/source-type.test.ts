import { describe, expect, it } from "vitest";
import {
  SOURCE_TYPES,
  normalizeSourceType,
  resolveSourceType,
  sourceTypeFromDomain,
} from "@/modules/digital-profile/orion-golden/analytics/source-type";
import { clientLink } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";

describe("тип источника по домену", () => {
  it("узнаёт очевидные площадки", () => {
    expect(sourceTypeFromDomain("ru.wikipedia.org")).toBe("Энциклопедия / справочник");
    expect(sourceTypeFromDomain("www.youtube.com")).toBe("Видеохостинг");
    expect(sourceTypeFromDomain("vk.com")).toBe("Соцсеть");
    expect(sourceTypeFromDomain("dzen.ru")).toBe("Блог / личный сайт");
    expect(sourceTypeFromDomain("opensanctions.org")).toBe("База данных / реестр");
    expect(sourceTypeFromDomain("council.gov.ru")).toBe("Официальный сайт / госресурс");
  });

  it("незнакомый домен не угадывает", () => {
    expect(sourceTypeFromDomain("kapitalnytt.se")).toBeUndefined();
    expect(sourceTypeFromDomain("")).toBeUndefined();
    expect(sourceTypeFromDomain(undefined)).toBeUndefined();
  });
});

describe("значение из закрытого списка", () => {
  it("принимает только известные названия", () => {
    expect(normalizeSourceType("Новостное СМИ")).toBe("Новостное СМИ");
    expect(normalizeSourceType("новостное сми")).toBe("Новостное СМИ");
    expect(normalizeSourceType("газета")).toBeUndefined();
    expect(normalizeSourceType(undefined)).toBeUndefined();
  });

  it("список не пустой и без повторов", () => {
    expect(new Set(SOURCE_TYPES).size).toBe(SOURCE_TYPES.length);
  });
});

describe("выбор типа для строки таблицы", () => {
  it("решение модели сильнее догадки по домену", () => {
    expect(
      resolveSourceType({ fromVerdict: "Новостное СМИ", domain: "ru.wikipedia.org" })
    ).toBe("Новостное СМИ");
  });

  it("без решения модели берётся домен", () => {
    expect(resolveSourceType({ domain: "ru.wikipedia.org" })).toBe("Энциклопедия / справочник");
  });

  it("когда не знает ни то ни другое — молчит", () => {
    expect(resolveSourceType({ fromVerdict: "что-то своё", domain: "kapitalnytt.se" })).toBeUndefined();
  });
});

describe("ссылка для клиента", () => {
  it("печатается без протокола и без хвостового слеша", () => {
    expect(clientLink("https://www.rbc.ru/business/12345/", "rbc.ru")).toBe("rbc.ru/business/12345");
  });

  it("процентные коды раскрываются: адрес читает человек", () => {
    expect(clientLink("https://ru.wikipedia.org/wiki/%D0%9A%D0%B5%D1%80%D0%B8%D0%BC%D0%BE%D0%B2", "ru.wikipedia.org")).toBe(
      "ru.wikipedia.org/wiki/Керимов"
    );
  });

  it("длинный адрес печатается целиком: полоса идёт во всю ширину листа", () => {
    const long = `https://example.org/${"a".repeat(200)}`;
    const text = clientLink(long, "example.org");
    expect(text).toBe(`example.org/${"a".repeat(200)}`);
    expect(text.endsWith("…")).toBe(false);
  });

  it("без адреса печатается домен, а не пустота", () => {
    expect(clientLink(undefined, "rbc.ru")).toBe("rbc.ru");
    expect(clientLink("", undefined)).toBe("—");
  });
});

describe("запасной список по доменам", () => {
  /**
   * Прогон 14.08: столбец «Тип источника» пустовал у 24 строк из 120, и почти
   * все — крупные издания. Страницы не прочитались (429 и пустой текст), а
   * домен их не узнавал: прочерк напротив «АиФ» читателю ничего не сообщает.
   */
  const known: Array<[string, string]> = [
    ["rbc.ru", "Новостное СМИ"],
    ["aif.ru", "Новостное СМИ"],
    ["gazeta.ru", "Новостное СМИ"],
    ["ntv.ru", "Новостное СМИ"],
    ["mk.ru", "Новостное СМИ"],
    ["starhit.ru", "Новостное СМИ"],
    ["ura.news", "Новостное СМИ"],
    ["news.liga.net", "Новостное СМИ"],
    ["imdb.com", "Энциклопедия / справочник"],
    ["tadviser.ru", "Энциклопедия / справочник"],
    ["xfirm.ru", "База данных / реестр"],
    ["prima-inform.ru", "База данных / реестр"],
    ["ofk-of-timati.orgs.biz", "База данных / реестр"],
    ["yandex.ru", "Агрегатор / каталог"],
  ];

  it("узнаёт площадки, чья природа известна без чтения", () => {
    for (const [domain, type] of known) {
      expect(sourceTypeFromDomain(domain), domain).toBe(type);
    }
  });

  it("незнакомому домену тип не выдумывает", () => {
    for (const domain of ["memoryon.net", "needspec.ru", "hrbooking.com", "example.org"]) {
      expect(sourceTypeFromDomain(domain), domain).toBeUndefined();
    }
  });

  it("«news» засчитывается меткой домена, а не куском чужого слова", () => {
    expect(sourceTypeFromDomain("news.example.com")).toBe("Новостное СМИ");
    expect(sourceTypeFromDomain("newsroom.company.com")).toBeUndefined();
  });
});
