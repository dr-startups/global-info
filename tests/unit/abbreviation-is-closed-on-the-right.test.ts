/**
 * Сокращение в словаре закрыто справа — правило, а не правка двух слов.
 *
 * «ФСБР» — Федерация спортивной борьбы России — два отчёта подряд печаталась
 * клиенту темой «Внимание по линии безопасности / оборонный контур» высокого
 * уровня и красилась негативом: основа `фсб` стояла без правой границы, и её
 * ловило любое слово, которое с неё начинается. Расшифровку сокращения печатал
 * тот же документ страницей ниже.
 *
 * Чинить это поимённо бесполезно: одно слово живёт в четырёх словарях трёх
 * файлов, и починка одного оставляет дефект в трёх — ровно так жалоба
 * воспроизвелась на новой опоре после первой починки. Поэтому проверка идёт по
 * классу: правило записано одной функцией, словари перечислены списком и
 * обходятся циклом, а полнота списка сверяется с самим исходником — словарь,
 * добавленный завтра, либо попадает под правило, либо его отсутствие видно в
 * диффе.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileFindingThemesConfig,
  findingThemesDictionaries,
  FindingThemesConfigError,
  FindingThemesConfigJsonSchema,
  getDefaultFindingThemesConfigJson,
  unclosedAbbreviations,
} from "@/modules/digital-profile/config/finding-themes";
import { CANONICAL_THEME_DEFS } from "@/modules/digital-profile/orion-golden/analytics/canonical-themes";
import {
  BENCHMARK_THEMES,
  NOISE_PATTERNS,
} from "@/modules/digital-profile/orion-golden/analytics/benchmark-trace";

const SRC = join(process.cwd(), "src/modules/digital-profile");
const BENCHMARK_TRACE_SRC = join(SRC, "orion-golden/analytics/benchmark-trace.ts");
const CANONICAL_THEMES_SRC = join(SRC, "orion-golden/analytics/canonical-themes.ts");

type Dictionary = { where: string; source: string };

/**
 * Словари каталога находок перечисляет он сам — тем же вызовом, которым их
 * обходит отказ компиляции. Своё перечисление здесь было бы вторым ответом на
 * вопрос «какие в каталоге словари».
 */
function catalogueDictionaries(): Dictionary[] {
  return findingThemesDictionaries(getDefaultFindingThemesConfigJson()).map((d) => ({
    where: `finding-themes/${d.label}`,
    source: d.source,
  }));
}

function canonicalDictionaries(): Dictionary[] {
  return CANONICAL_THEME_DEFS.map((d) => ({
    where: `canonical-themes/${d.themeId}`,
    source: d.keywords.source,
  }));
}

function benchmarkDictionaries(): Dictionary[] {
  return [
    ...BENCHMARK_THEMES.map((b) => ({
      where: `benchmark-trace/${b.benchmarkId}`,
      source: b.keywords.source,
    })),
    { where: "benchmark-trace/NOISE_PATTERNS", source: NOISE_PATTERNS.source },
  ];
}

/**
 * Источники регулярных литералов файла — по содержимому, флаги любые.
 *
 * Якорь по знаку перед литералом (`=`, `:`, `(`, `,`, `[`) отделяет выражение
 * от косой черты внутри прозы комментариев («Оборона / национальная
 * безопасность»).
 */
function regexLiteralSources(src: string): string[] {
  const out: string[] = [];
  const literal = /[=:(,[]\s*\/((?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/[a-z]*/gu;
  for (const m of src.matchAll(literal)) out.push(m[1]!);
  return out;
}

function allDictionaries(): Dictionary[] {
  return [...catalogueDictionaries(), ...canonicalDictionaries(), ...benchmarkDictionaries()];
}

describe("правило: сокращение закрыто справа", () => {
  it("незакрытое сокращение названо, закрытое — нет", () => {
    expect(unclosedAbbreviations("оборон|фсб|fsb|security service")).toEqual(["фсб", "fsb"]);
    expect(unclosedAbbreviations("оборон|ФСБ(?!\\p{L})|FSB(?!\\p{L})|security service")).toEqual(
      []
    );
  });

  /**
   * Ни одного из этих сокращений в словарях проекта нет. Они здесь затем, чтобы
   * было видно: защита не поимённая — ФСИН, ГРУ, IBA и ЦУПИС закрываются
   * правилом, не будучи названными в коде.
   */
  it("сокращение опознаётся записью прописными или отсутствием гласных", () => {
    expect(unclosedAbbreviations("ФСИН|ГРУ|IBA|ЦУПИС|МЧС|мчс")).toEqual([
      "ФСИН",
      "ГРУ",
      "IBA",
      "ЦУПИС",
      "МЧС",
      "мчс",
    ]);
  });

  /**
   * Универсальная правая граница отвергнута замером: `сын(?!\p{L})` теряет
   * «сына», `fraud(?!\p{L})` — «fraudulent», `биограф(?!\p{L})` — «биографию»
   * на 106 материалах живого прогона. Русская основа обязана расти, сокращение
   * — нет, и правило отделяет ровно тот подкласс, где закрытие ничего не стоит.
   */
  it("растущая основа сокращением не считается", () => {
    expect(
      unclosedAbbreviations("сын|fraud|биограф|владел|суд|прокур|ownership|бенефициар")
    ).toEqual([]);
  });

  it("закрытием считается только просмотр вперёд", () => {
    expect(unclosedAbbreviations("ФСБ(?!\\p{L})")).toEqual([]);
    expect(unclosedAbbreviations("ФСБ(?=[^\\p{L}\\p{N}]|$)")).toEqual([]);
  });

  /**
   * `\b` закрытием не считается, и это не придирка к форме записи.
   *
   * Граница слова в JavaScript определена на ASCII: после «У», «Н», «Б» она не
   * срабатывает никогда, поэтому `ГРУ\b` не совпадает даже с самим «ГРУ» —
   * словарь молча умирает целиком. У латиницы дыра обратная: в «FSBа» с
   * кириллической «а» граница есть, и `FSB\b` совпадает ровно с тем словом,
   * ради которого правило заведено. Ровно это написано в комментарии
   * `FSB_ABBREVIATION`, и предикат обязан отвечать так же.
   */
  it("граница слова сокращение не закрывает", () => {
    expect(unclosedAbbreviations("ФСБ\\b")).toEqual(["ФСБ\\b"]);
    expect(unclosedAbbreviations("оборон|ГРУ\\b|спецслужб")).toEqual(["ГРУ\\b"]);
    expect(unclosedAbbreviations("FSB\\b")).toEqual(["FSB\\b"]);

    // Почему ответ правила верен: обе записи с `\b` не значат того, что
    // хотел написавший.
    expect(/(?<!\p{L})(?:ГРУ\b)/iu.test("ГРУ")).toBe(false);
    expect(/(?<!\p{L})(?:FSB\b)/iu.test("FSBа")).toBe(true);
  });

  /**
   * Случай, который правило пропускает **по признаку, а не по границе**: в
   * `bvi` есть гласная и записано оно строчными, то есть сокращением по своим
   * двум признакам не выглядит. Правая граница у него `\b`, и это отдельная
   * известная дыра («BVIя» совпадает) — закрывать её здесь значило бы менять
   * состав тем, а не форму записи.
   */
  it("слово с гласной под правило не попадает, чем бы ни было закрыто", () => {
    expect(unclosedAbbreviations("\\bbvi\\b")).toEqual([]);
    expect(unclosedAbbreviations("bvi")).toEqual([]);
  });

  it("граница слева сокращение не закрывает", () => {
    expect(unclosedAbbreviations("(?<!\\p{L})ФСБ")).toEqual(["(?<!\\p{L})ФСБ"]);
  });
});

describe("правило применяется ко всем словарям трёх файлов сразу", () => {
  it("ни один словарь не оставляет сокращение открытым", () => {
    const открытые = allDictionaries().flatMap((d) =>
      unclosedAbbreviations(d.source).map((alt) => `${d.where}: ${alt}`)
    );
    expect(открытые).toEqual([]);
  });

  /**
   * Проверка, сделавшая ноль сравнений, — провал, а не успех: пустой список
   * словарей и разбор, не нашедший ни одной альтернативы, выглядят зелёными.
   */
  it("проверка не пуста: в каждом словаре нарушение было бы замечено", () => {
    const dictionaries = allDictionaries();
    // Порог — по факту, а не «с запасом вниз»: при 41 словаре порог 25
    // позволял потерять шестнадцать зелёным.
    expect(dictionaries.length).toBeGreaterThanOrEqual(41);
    for (const d of dictionaries) {
      expect(
        unclosedAbbreviations(`${d.source}|ГРУ`),
        `словарь ${d.where} правилом не разобран`
      ).toEqual(["ГРУ"]);
    }
  });

  /**
   * Полнота списка сверяется с исходниками, а не с памятью: словарь, заведённый
   * в одном из трёх файлов и не попавший в обход, — это молчащее правило.
   */
  it("список словарей полон — сверено с самими исходниками", () => {
    // Постусловие на само перечисление: словарное поле схемы, которое каталог
    // не назвал, правило не увидит вовсе — ни в компиляции, ни здесь.
    const enumerated = new Set(
      findingThemesDictionaries(getDefaultFindingThemesConfigJson()).map((d) => d.label)
    );
    const schemaKeys = Object.keys(FindingThemesConfigJsonSchema.shape).filter(
      (k) => k !== "version" && k !== "themes" && !k.endsWith("Flags")
    );
    expect(schemaKeys.length).toBeGreaterThanOrEqual(8);
    for (const key of schemaKeys) {
      expect(enumerated.has(key), `словарь ${key} каталогом не перечислен`).toBe(true);
    }
    for (const theme of getDefaultFindingThemesConfigJson().themes) {
      expect(
        enumerated.has(`themes[${theme.themeId}].keywords`),
        `слова темы ${theme.themeId} каталогом не перечислены`
      ).toBe(true);
      // Площадки темы — такой же словарь: удаление их ветки из перечисления
      // выглядит в диффе упрощением и выводит их из-под правила молча.
      if (theme.domains) {
        expect(
          enumerated.has(`themes[${theme.themeId}].domains`),
          `площадки темы ${theme.themeId} каталогом не перечислены`
        ).toBe(true);
      }
    }
    expect(
      getDefaultFindingThemesConfigJson().themes.filter((t) => t.domains).length
    ).toBeGreaterThanOrEqual(4);

    // Словари эталонной трассы сверяются по **содержимому** литералов, а не по
    // подстроке «/iu»: порядок флагов произволен, и словарь, записанный `/giu`,
    // не попадал ни в обход, ни в счёт — молча.
    const benchmarkLiterals = regexLiteralSources(readFileSync(BENCHMARK_TRACE_SRC, "utf8"));
    const benchmarkKnown = new Set(benchmarkDictionaries().map((d) => d.source));
    expect(benchmarkLiterals.length).toBe(benchmarkDictionaries().length);
    for (const source of benchmarkLiterals) {
      expect(
        benchmarkKnown.has(source),
        `словарь benchmark-trace «${source.slice(0, 40)}…» правилом не обходится`
      ).toBe(true);
    }

    // У канонических тем словари собирает помощник, литералов в файле нет
    // вовсе: сверяются оба факта, иначе `const EXTRA = themeKeywords([…])`
    // пройдёт незамеченным.
    const canonicalSrc = readFileSync(CANONICAL_THEMES_SRC, "utf8");
    expect(canonicalSrc.match(/themeKeywords\(/gu)?.length ?? 0).toBe(
      canonicalDictionaries().length + 1
    );
    expect(regexLiteralSources(canonicalSrc)).toEqual([]);
  });
});

describe("каталог с незакрытым сокращением не компилируется", () => {
  function catalogueWith(patch: {
    themeKeywords?: string;
    adversePatterns?: string;
  }): ReturnType<typeof getDefaultFindingThemesConfigJson> {
    const json = getDefaultFindingThemesConfigJson();
    return {
      ...json,
      themes: patch.themeKeywords
        ? json.themes.map((t, i) => (i === 0 ? { ...t, keywords: patch.themeKeywords! } : t))
        : json.themes,
      adversePatterns: patch.adversePatterns ?? json.adversePatterns,
    };
  }

  const meta = { source: "override" as const, overridePath: "/tmp/finding-themes.json" };

  it("тема с голым «ФСБ» отвергается, и слово названо", () => {
    let error: unknown;
    try {
      compileFindingThemesConfig(catalogueWith({ themeKeywords: "оборон|ФСБ" }), meta);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(FindingThemesConfigError);
    expect(String((error as Error).message)).toContain("ФСБ");
    expect(String((error as Error).message)).toContain("security_scrutiny");
  });

  it("словарь негатива с голым «ГРУ» отвергается тем же правилом", () => {
    let error: unknown;
    try {
      // Слово дописывается к общему словарю, а не подменяет его: иначе первым
      // отказывает проверка подмножества сильных слов, и правило границы не
      // проверено вовсе.
      compileFindingThemesConfig(
        catalogueWith({
          adversePatterns: `${getDefaultFindingThemesConfigJson().adversePatterns}|ГРУ`,
        }),
        meta
      );
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(FindingThemesConfigError);
    expect(String((error as Error).message)).toContain("ГРУ");
    expect(String((error as Error).message)).toContain("adversePatterns");
  });

  /**
   * Сквозной случай: закрыть кириллическое сокращение самым очевидным способом
   * (`ФСБ\b`) — и получить словарь, который не совпадает ни с чем. Правило
   * обязано остановить это на загрузке каталога, а не выдать лицензию.
   */
  it("тема, закрытая границей слова, отвергается — иначе словарь молчит на настоящем ФСБ", () => {
    let error: unknown;
    try {
      compileFindingThemesConfig(catalogueWith({ themeKeywords: "оборон|ФСБ\\b|спецслужб" }), meta);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(FindingThemesConfigError);
    expect(String((error as Error).message)).toContain("ФСБ");
  });

  it("сегодняшний каталог по умолчанию компилируется", () => {
    expect(() =>
      compileFindingThemesConfig(getDefaultFindingThemesConfigJson(), {
        source: "default",
        overridePath: null,
      })
    ).not.toThrow();
  });
});
