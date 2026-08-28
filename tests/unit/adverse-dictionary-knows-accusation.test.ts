/**
 * Словарь негатива знает обвинение — и не знает благополучия.
 *
 * Один и тот же сюжет был размечен по-разному, потому что словарь не знал ни
 * «обвин», ни «нападени», ни «избие»: «Сульянов обвинил Кремлева в нападении» и
 * «Умар Кремлев обвинен в избиении на Красной площади» сходились на «Не
 * проверено», хотя это одно и то же событие в двух подачах.
 *
 * **Цена ошибки здесь симметрична, и это главное.** Отчёт читает сам субъект,
 * который хочет убрать нежелательное. Пропущенный негатив оставляет строку «Не
 * проверено» — читатель видит заголовок и слова о том, что страницу не
 * открывали. Ложный «Нежелательный» на благоприятном материале предлагает ему
 * убирать хорошее о себе, и «Биография Умара Кремлева и его путь к успеху» на
 * `klerk.ru` уже была так помечена. Поэтому здесь закреплены обе стороны:
 * каждое новое слово проверено и на том, что оно ловит, и на том, где оно
 * попадается случайно.
 */

import { describe, expect, it } from "vitest";
import {
  compileFindingThemesConfig,
  FindingThemesConfigError,
  getAdversePatterns,
  getDefaultFindingThemesConfigJson,
  type FindingThemesConfigJson,
} from "@/modules/digital-profile/config/finding-themes";
import {
  classifyObservationHighlight,
  resolveRowAdverse,
} from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import type { PersistedSerpObservation } from "@/modules/digital-profile/serp-observation/types";

/** Непрочитанная страница обычного издания: ни вердикта, ни правки аналитика. */
function row(title: string, snippet: string | null = null): boolean {
  return resolveRowAdverse({
    url: "https://news-example.ru/a",
    domain: "news-example.ru",
    title,
    snippet,
  });
}

/** Мягкая площадка: биография, реестр, энциклопедия — работает только сильный словарь. */
function soft(title: string): boolean {
  return resolveRowAdverse({
    url: "https://klerk.ru/buh/news/1",
    domain: "klerk.ru",
    title,
  });
}

function compiled(json: FindingThemesConfigJson) {
  return compileFindingThemesConfig(json, {
    source: "override",
    overridePath: "/dev/null/finding-themes.json",
  });
}

describe("два заголовка одного сюжета получают одно слово", () => {
  const ACCUSED = "Умар Кремлев обвинен в избиении на Красной площади";
  const ACCUSER = "Сульянов обвинил Кремлева в нападении";

  it("«обвинен в избиении» и «обвинил в нападении» — оба нежелательные", () => {
    expect(row(ACCUSED)).toBe(true);
    expect(row(ACCUSER)).toBe(true);
    expect(row(ACCUSED)).toBe(row(ACCUSER));
  });

  it("рамка на снимке идёт за тем же словарём, что и оценка строки", () => {
    const hl = classifyObservationHighlight({
      url: "https://news-example.ru/a",
      domain: "news-example.ru",
      title: ACCUSER,
      snippet: null,
    } as unknown as PersistedSerpObservation);
    expect(hl.isHighlighted).toBe(true);
    expect(hl.themeTitle).toBeTruthy();
  });
});

describe("благоприятный материал метки не получает", () => {
  const BIO = "Биография Умара Кремлева и его путь к успеху";

  it("биография не краснеет ни на мягкой площадке, ни на обычной", () => {
    expect(soft(BIO)).toBe(false);
    expect(row(BIO)).toBe(false);
  });

  it("«обвин» не краснит мягкую площадку: в оглавлении справочника это рубрика", () => {
    expect(soft("Кремлёв Умар Назарович: биография, бизнес, обвинения")).toBe(false);
  });
});

describe("новые корни: что ловят и где попадаются случайно", () => {
  /**
   * Строки подобраны так, чтобы совпадение давал **только** проверяемый корень:
   * «прокуратура предъявила обвинение» покраснела бы и до правки, по «прокур»,
   * и такая проверка не сторожила бы ничего.
   */
  const CATCHES: Array<[string, string]> = [
    ["обвин", "Ему предъявлено обвинение"],
    ["нападени", "Нападение на предпринимателя у офиса"],
    ["избие", "Избиение произошло у стен стадиона"],
    ["побо", "Заявление о побоях подано в полицию"],
    ["побо (косвенный падеж)", "По побоям возбуждено производство"],
    ["насил", "Насилие в семье предпринимателя"],
    ["prosecut", "Prosecutors request documents from the founder"],
    ["whistleblow", "Whistleblower portal mentions the founder"],
    ["ofac", "OFAC entry for the founder"],
    ["pep", "UAE PEP screening result"],
    ["rca", "Dow Jones RCA match"],
    ["lawsuit", "Class action lawsuit filed by investors"],
    ["offshore", "Malta offshore holding structure"],
    ["офшор", "Офшорная структура на Кипре"],
    ["оффшор", "Оффшорная структура на Кипре"],
    ["бенефициар", "Бенефициаром фонда указан предприниматель"],
    ["нежелат", "Нежелательные публикации в выдаче"],
    ["негативн", "Негативные материалы о предпринимателе"],
    ["undesirable", "Undesirable content about the founder"],
  ];

  it.each(CATCHES)("«%s» ловит: %s", (_root, text) => {
    expect(getAdversePatterns().test(text)).toBe(true);
  });

  /**
   * Слова, в которых корень оказывается случайно. Ревью прошлой работы показало
   * цену отсутствия правой границы на живых примерах: «оправдан» совпадало
   * внутри «оправдания», «снято» — внутри «снятого».
   */
  const MISSES: Array<[string, string]> = [
    ["избие ≠ избиратель", "Избирательная комиссия утвердила список"],
    ["избие ≠ избирком", "Избирком принял документы"],
    ["побо ≠ поборник", "Поборник строгих правил в отрасли"],
    ["побо ≠ поборы", "Поборы на дорогах региона"],
    ["побо ≠ побочный", "Побочный эффект решения"],
    ["побо ≠ побоище", "Ледовое побоище в школьном учебнике"],
    ["насил ≠ насилу", "Насилу добрался до финиша"],
    ["нападени ≠ нападающий", "Нападающий сборной забросил три шайбы"],
    ["pep ≠ pepper", "Pepper spray sold at the store"],
    ["pep ≠ Pepsi", "Pepsi opens a plant"],
    ["pep ≠ pepа (кириллица за латиницей)", "Список pepа обновлён"],
    ["rca ≠ Rcane", "Rcane Systems announced a merger"],
    ["rca ≠ carcass (буква слева)", "Carcass disposal rules"],
    ["ofac ≠ ofacа (кириллица за латиницей)", "Реестр ofacа обновлён"],
    ["негативн ≠ фотонегатив (буква слева)", "Фотонегативная плёнка в архиве"],
  ];

  it.each(MISSES)("%s", (_case, text) => {
    expect(getAdversePatterns().test(text)).toBe(false);
  });

  it("законные формы «насил» остаются", () => {
    expect(getAdversePatterns().test("Насильственные действия квалифицированы")).toBe(true);
    expect(getAdversePatterns().test("В материале сказано: насилуют и угрожают")).toBe(true);
  });
});

describe("на мягкой площадке краснит только происшествие", () => {
  it("избиение, нападение, побои и насилие краснят и справочник", () => {
    expect(soft("Умар Кремлев обвинен в избиении на Красной площади")).toBe(true);
    expect(soft("Сульянов обвинил Кремлева в нападении")).toBe(true);
    expect(soft("Заявление о побоях подано в полицию")).toBe(true);
    expect(soft("Насилие в семье предпринимателя")).toBe(true);
  });

  it("категория комплаенса и метаслова мягкую площадку не краснят", () => {
    for (const title of [
      "UAE PEP screening result",
      "Dow Jones RCA match",
      "OFAC entry for the founder",
      "Malta offshore holding structure",
      "Нежелательные публикации в выдаче",
      "Бенефициаром фонда указан предприниматель",
    ]) {
      expect(soft(title)).toBe(false);
      expect(row(title)).toBe(true);
    }
  });
});

describe("сильный словарь — подмножество общего, и это проверяется при компиляции", () => {
  it("словарь по умолчанию проверку проходит", () => {
    expect(() => compiled(getDefaultFindingThemesConfigJson())).not.toThrow();
  });

  it("сильное слово вне общего словаря отвергается с названной причиной", () => {
    const json: FindingThemesConfigJson = {
      ...getDefaultFindingThemesConfigJson(),
      adversePatterns: "санкц|уголов",
      strongAdversePatterns: "санкц|уголов|дезинформ",
    };
    expect(() => compiled(json)).toThrow(FindingThemesConfigError);
    expect(() => compiled(json)).toThrow(/дезинформ/u);
  });

  it("файл без сильного словаря наследует только то, что знает его общий", () => {
    // Так устроен `finding-themes.example.json`: свой `adversePatterns` есть,
    // `strongAdversePatterns` нет. Наследовать сильный список целиком нельзя —
    // «arrest» краснил бы мягкую площадку и не краснил обычную.
    const json: FindingThemesConfigJson = {
      ...getDefaultFindingThemesConfigJson(),
      adversePatterns: "санкц|sanction|уголов|criminal|арест|суд|скандал|расследован",
      strongAdversePatterns: undefined,
    };
    const cfg = compiled(json);
    expect(cfg.strongAdversePatterns.test("возбуждено уголовное дело")).toBe(true);
    expect(cfg.strongAdversePatterns.test("arrest of the founder")).toBe(false);
    expect(cfg.strongAdversePatterns.test("совершенно обычный заголовок")).toBe(false);
  });
});

describe("опровержение рядом со словом снимает и новое совпадение", () => {
  it("«Обвинения не подтвердились» нежелательным не становится", () => {
    expect(row("Обвинения не подтвердились")).toBe(false);
    expect(row("Обвинения в избиении не подтвердились")).toBe(false);
  });

  it("неснятое вхождение оставляет совпадение", () => {
    // Признак приёмки работы 7: до пополнения словаря у этого заголовка было
    // единственное совпадение «суд» вплотную к «отказал», и он терял метку.
    expect(row("Суд отказал в иске, но обвинения в избиении остаются")).toBe(true);
  });
});
