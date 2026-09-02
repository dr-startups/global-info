/**
 * Офшорные структуры и корпоративное владение — две темы, а не одна.
 *
 * Замечание владельца (Аудит 2, №6): ярлык «Офшоры / корпоративное владение»
 * обещает офшор там, где речь о покупке компании. Слово `владел` в общем
 * словаре ловило «стал владельцем "Рольфа"», а тема была обвиняющей и среднего
 * уровня — то есть отчёт предъявлял субъекту сделку как офшорный сигнал.
 *
 * Отсюда две разные темы с разным `accusing`: покупка компании — то, что
 * описывают, а не то, в чём обвиняют. И отсюда же вторая половина: обвиняющая
 * тема не берёт материал, чью страницу прочитали и признали благоприятной, — не
 * только не цитирует его, но и не считает своим.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildClientFacingClaim,
  clientThemeWhy,
  synthesizeFindings,
} from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import {
  compileFindingThemesConfig,
  getAdversePatterns,
  getFindingThemes,
  isAccusingTheme,
  type FindingThemesConfigJson,
  type ThemeDef,
} from "@/modules/digital-profile/config/finding-themes";
import { classifyCanonicalThemes } from "@/modules/digital-profile/orion-golden/analytics/canonical-themes";
import { BENCHMARK_THEMES } from "@/modules/digital-profile/orion-golden/analytics/benchmark-trace";
import type { ObservationVerdictByRef } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { SubjectResolutionItem } from "@/modules/digital-profile/orion-golden/contracts/subject-resolution";

const CASE_ID = "case-unit-ownership-theme";
const DATASET_ID = "ds-ownership-theme";

let seq = 0;
function item(
  partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">
): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-own-${seq}`,
    caseId: CASE_ID,
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "serper",
    region: "RU",
    collectedAt: "2026-08-28T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    rawMetadata: { surface: "organic", engine: "GOOGLE" },
    ...partial,
  };
}

function refOf(i: RawInventoryItem): string {
  return `inventory:${i.inventoryId}`;
}

function synthesize(items: RawInventoryItem[], verdictByRef?: ObservationVerdictByRef) {
  return synthesizeFindings({
    caseId: CASE_ID,
    datasetId: DATASET_ID,
    items,
    resolutionByRef: new Map(
      items.map((i) => [
        refOf(i),
        { evidenceRef: refOf(i), decision: "SUBJECT_MATCH" } as SubjectResolutionItem,
      ])
    ),
    sourceHashes: ["sha256:test"],
    verdictByRef,
  });
}

function themeIdsFor(one: RawInventoryItem, verdictByRef?: ObservationVerdictByRef): string[] {
  return synthesize([one], verdictByRef).themeAssignments.get(refOf(one)) ?? [];
}

function themeOf(themeId: string): ThemeDef {
  const found = getFindingThemes().find((t) => t.themeId === themeId);
  if (!found) throw new Error(`темы ${themeId} нет в каталоге`);
  return found;
}

const ROLF = 'Умар Кремлев стал владельцем "Рольфа"';

describe("покупка компании — не офшор", () => {
  it("«стал владельцем» стоит под корпоративным владением и не обвиняет", () => {
    const ownership = item({ title: ROLF, sourceUrl: "https://www.example-news.ru/kremlev-rolf" });
    expect(themeIdsFor(ownership)).toEqual(["corporate_ownership"]);

    const theme = themeOf("corporate_ownership");
    expect(theme.label).toBe("Корпоративное владение");
    expect(isAccusingTheme(theme)).toBe(false);

    const finding = synthesize([ownership]).bundle.findings.find((f) =>
      f.findingId.includes("corporate_ownership")
    );
    expect(finding?.theme).toBe("Корпоративное владение");
    expect(finding?.riskLevel).toBe("low");
  });

  it("офшорные слова остаются офшорной темой и обвиняют", () => {
    const offshore = item({
      title: "Кремлев связан с офшором на Кипре",
      sourceUrl: "https://www.example-news.ru/kremlev-cyprus",
    });
    expect(themeIdsFor(offshore)).toEqual(["offshore_structures"]);

    const theme = themeOf("offshore_structures");
    expect(theme.label).toBe("Офшорные структуры");
    expect(isAccusingTheme(theme)).toBe(true);
  });
});

describe("«бенефициар» — тема владения, а не офшора", () => {
  /*
   * Раскрытие бенефициара — сведения о владении; офшор — юрисдикция. Пока
   * `бенефициар|beneficia` стояли в офшорной теме, карточка государственного
   * реестра застройщиков («ИНН. Гражданство. Российская Федерация.
   * Бенефициар. Кремлёв Умар Назарович.») выходила клиенту «Офшорными
   * структурами» среднего уровня с советом подготовить схему владения по
   * офшорным юрисдикциям — при том что ни один источник об офшоре не говорил.
   *
   * Тот же ответ уже дают два других каталога проекта: `canonical-themes.ts`
   * относит термин к деловым связям и владению, `benchmark-trace.ts` — к
   * корпоративному владению. Разъехаться им теперь не даёт проверка ниже.
   */
  /*
   * Формы термина перебираются целиком и на обоих языках сразу: правило одно
   * («у одного сюжета один ярлык»), и проверка обязана падать, когда его
   * закрыли на одном языке и забыли на другом. Русские формы взяты по замеру
   * склонения — прилагательное («бенефициарный … бенефициарными») и парное
   * написание через дефис («бенефициар-владелец»).
   */
  it.each([
    ["Beneficial ownership disclosure lists Anders Holmström for Nordkap Capital"],
    ["Beneficial-ownership registry updated by the regulator"],
    ["Бенефициарный владелец компании раскрыт в реестре"],
    ["Бенефициарным владельцем оказался Умар Кремлев"],
    ["Раскрытие бенефициарного владельца по требованию банка"],
    ["Реестр бенефициарных владельцев обновлён после проверки"],
    ["Конечный бенефициарный владелец назван в отчёте аудитора"],
    ["Проверка бенефициара-владельца завершена в срок"],
    // Обратный порядок парного написания: оговорка симметрична, иначе дефис
    // учтён в одну сторону из двух и на этих строках двойной ярлык возвращается.
    ["Владелец-бенефициар назван в реестре"],
    ["Сведения о владельце-бенефициаре внесены в реестр"],
    ["Документ подписан владельцами-бенефициарами компании"],
    // Карточка государственного реестра застройщиков — опора ложной офшорной
    // темы в живом отчёте.
    ["ИНН. 231213588320. Гражданство. Российская Федерация. Бенефициар. Кремлёв Умар Назарович."],
  ])("«%s» — только корпоративное владение", (title) => {
    expect(themeIdsFor(item({ title, sourceUrl: "https://www.example-news.ru/beneficial" })))
      .toEqual(["corporate_ownership"]);
  });

  /*
   * Слово «офшор» в самом заголовке — законная опора офшорной темы, и переезд
   * термина её не отменяет: две темы здесь стоят на двух разных словах, а не на
   * одном. Ровно этим случай отличается от карточки реестра застройщиков, где
   * офшорного слова нет вовсе.
   */
  it("офшорное слово рядом с термином оставляет обе темы", () => {
    const both = item({
      title: "Anders Holmström linked to Malta holding structure and offshore beneficial ownership",
      sourceUrl: "https://www.example-news.ru/malta",
    });
    expect(themeIdsFor(both).sort()).toEqual(["corporate_ownership", "offshore_structures"]);
  });

  it.each([
    ["Ownership structure of Nordkap Capital disclosed in the registry"],
    ['Умар Кремлев стал владельцем "Рольфа"'],
    ["Смена владельца актива зафиксирована в реестре"],
  ])("«%s» — владение без термина остаётся корпоративной темой", (title) => {
    expect(themeIdsFor(item({ title, sourceUrl: "https://www.example-news.ru/ownership" })))
      .toEqual(["corporate_ownership"]);
  });

  it.each([
    ["Кремлев связан с офшором на Кипре"],
    ["Акции принадлежат кипрскому офшору «Деланс лимитед»"],
    ["Malta offshore vehicle registered for the group"],
  ])("«%s» — офшор остаётся офшором", (title) => {
    const offshore = item({ title, sourceUrl: "https://www.example-news.ru/offshore" });
    expect(themeIdsFor(offshore)).toEqual(["offshore_structures"]);
    expect(themeOf("offshore_structures").baseRisk).toBe("medium");
    expect(isAccusingTheme(themeOf("offshore_structures"))).toBe(true);
  });

  /*
   * Раскрытие бенефициара — подача документов, а не сигнал: субъекту
   * предлагалось бы убирать собственное раскрытие. Аргумент был записан в
   * словаре про английскую форму, а русская прожила дольше только потому, что
   * мерить её было негде — золотой кейс англо-шведский.
   */
  it("раскрытие бенефициара строку не красит, а настоящий негатив красит", () => {
    const adverse = getAdversePatterns();
    expect(
      adverse.test("ИНН. 231213588320. Гражданство. Российская Федерация. Бенефициар. Кремлёв Умар Назарович.")
    ).toBe(false);
    expect(adverse.test("Кремлёв также стал бенефициаром трёх букмекерских контор")).toBe(false);
    expect(adverse.test("введены санкции против компании")).toBe(true);
    expect(adverse.test("возбуждено уголовное дело")).toBe(true);
    expect(adverse.test("арест имущества по требованию кредитора")).toBe(true);
  });

  /*
   * Одно слово живёт в трёх каталогах, и разъехаться им нельзя: ровно так тема
   * переехала на новую опору после первой починки. `finding-themes.ts` — тот
   * единственный каталог, из которого собирается матрица рисков, и он один
   * говорил «офшор» там, где два других уже говорили «владение».
   */
  it("тему бенефициара одинаково называют все три каталога", () => {
    // Строка держит **само слово**, а не соседнее «владел»: у «бенефициарного
    // владельца» тема нашлась бы и без него, и проверка «в трёх каталогах»
    // проверяла бы два из трёх (замерено ревью).
    const текст = "Бенефициар раскрыт в реестре";
    expect(themeIdsFor(item({ title: текст, sourceUrl: "https://www.example-news.ru/b" }))).toEqual([
      "corporate_ownership",
    ]);

    const canonical = classifyCanonicalThemes(текст);
    expect(canonical).toContain("business_ownership_associates");
    expect(canonical).not.toContain("offshore_financial_transparency");

    const benchmark = BENCHMARK_THEMES.filter((b) => b.keywords.test(текст)).map(
      (b) => b.benchmarkId
    );
    expect(benchmark).toContain("bm-corporate-ownership");
    expect(benchmark).not.toContain("bm-offshore");
  });

  /*
   * Тема строится из материалов: при нуле материалов бакета нет и находки нет.
   * Никакого «снятия темы» заводить не нужно — это был бы второй ответ на
   * вопрос «есть ли тема».
   */
  it("тема без материалов не печатается пустой плиткой", () => {
    const corpus = [
      item({ title: "Бенефициар. Кремлёв Умар Назарович. Доля. 50 %", sourceUrl: "https://nash.dom.rf/z/1" }),
      item({ title: "Умар Кремлев стал владельцем актива", sourceUrl: "https://www.example-news.ru/a" }),
    ];
    const findings = synthesize(corpus).bundle.findings;
    expect(findings.map((f) => f.findingId.split("-")[1])).toEqual(["corporate_ownership"]);
  });
});

describe("обвиняющая тема не берёт благоприятно прочитанную страницу", () => {
  const both = () =>
    item({
      title: "Кремлев стал владельцем офшорной компании на Кипре",
      sourceUrl: "https://www.example-news.ru/kremlev-cyprus-deal",
    });

  it("без решения по странице материал стоит в обеих темах", () => {
    expect(themeIdsFor(both()).sort()).toEqual(["corporate_ownership", "offshore_structures"]);
  });

  it("благоприятно прочитанная страница остаётся только в описательной теме", () => {
    const material = both();
    const supportive: ObservationVerdictByRef = {
      [refOf(material)]: { tone: "supportive", quoted: true, subjectMatch: "subject" },
    };
    expect(themeIdsFor(material, supportive)).toEqual(["corporate_ownership"]);

    const findings = synthesize([material], supportive).bundle.findings;
    expect(findings.map((f) => f.theme)).toEqual(["Корпоративное владение"]);
    expect(findings.flatMap((f) => f.evidenceRefs)).toEqual([refOf(material)]);
  });

  it("нейтрально прочитанная страница обвиняющей темы тоже не питает", () => {
    const material = both();
    const neutral: ObservationVerdictByRef = {
      [refOf(material)]: { tone: "neutral", quoted: true, subjectMatch: "subject" },
    };
    expect(themeIdsFor(material, neutral)).toEqual(["corporate_ownership"]);
  });

  it("решение аналитика сильнее прочитанной страницы и здесь", () => {
    const material = both();
    material.rawMetadata = { ...material.rawMetadata, analystAdverse: true };
    const supportive: ObservationVerdictByRef = {
      [refOf(material)]: { tone: "supportive", quoted: true, subjectMatch: "subject" },
    };
    expect(themeIdsFor(material, supportive).sort()).toEqual([
      "corporate_ownership",
      "offshore_structures",
    ]);
  });
});

describe("уровень описательной темы растёт вместе с негативом", () => {
  /*
   * `baseRisk` каталога — начальный уровень, а не потолок: `riskFor` поднимает
   * низкую тему до высокой при трёх и более негативных материалах, и признак
   * «обвиняет ли тема» на это не влияет — он решает, какие материалы вообще в
   * тему попадут, а не как считается уровень набравшихся. Правило общее для
   * всех тем; закреплено, чтобы «Корпоративное владение» с высоким уровнем не
   * читалось как ошибка ярлыка.
   */
  it("три негативных материала поднимают корпоративное владение до высокого", () => {
    const adverse = (n: number) =>
      item({
        title: `Умар Кремлев стал владельцем актива ${n} после ареста счетов`,
        sourceUrl: `https://www.example-news.ru/kremlev-asset-${n}`,
      });
    const materials = [adverse(1), adverse(2), adverse(3)];
    const finding = synthesize(materials).bundle.findings.find((f) =>
      f.findingId.includes("corporate_ownership")
    );
    expect(finding?.riskLevel).toBe("high");
  });

  it("без негатива уровень остаётся тем, что задал каталог", () => {
    const calm = item({
      title: 'Умар Кремлев стал владельцем "Рольфа"',
      sourceUrl: "https://www.example-news.ru/kremlev-rolf-calm",
    });
    const finding = synthesize([calm]).bundle.findings.find((f) =>
      f.findingId.includes("corporate_ownership")
    );
    expect(finding?.riskLevel).toBe("low");
  });
});

describe("у каждой темы каталога свои слова для клиента", () => {
  const GENERIC_WHY = "Для банка, инвестора или контрагента это сигнал к углублённой проверке.";

  it("ни одна тема не печатается общим шаблоном", () => {
    for (const theme of getFindingThemes()) {
      const claim = buildClientFacingClaim({
        theme,
        itemsCount: 1,
        adverseCount: 0,
        examples: [],
      });
      expect(claim, `тема ${theme.themeId} без присказки`).not.toContain(
        `Найдены публикации по теме «${theme.label}»`
      );
      expect(clientThemeWhy(theme.themeId), `тема ${theme.themeId} без объяснения`).not.toBe(
        GENERIC_WHY
      );
      expect(theme.recommendedAction.length).toBeGreaterThan(0);
    }
  });
});

describe("файл переопределения каталога продолжает компилироваться", () => {
  const EXAMPLE_PATH = join(
    process.cwd(),
    "src/modules/digital-profile/config/finding-themes.example.json"
  );

  it("пример переопределения без списка доменов проходит схему", () => {
    const json = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8")) as FindingThemesConfigJson;
    const compiled = compileFindingThemesConfig(json, {
      source: "override",
      overridePath: EXAMPLE_PATH,
    });
    expect(compiled.themes.map((t) => t.themeId)).toEqual([
      "criminal_legal",
      "business_profile",
      "industry_contour",
    ]);
    expect(compiled.themes.every((t) => t.domains === null)).toBe(true);
  });

  it("названный список доменов компилируется и адрес читает целиком", () => {
    const json = JSON.parse(readFileSync(EXAMPLE_PATH, "utf8")) as FindingThemesConfigJson;
    const compiled = compileFindingThemesConfig(
      {
        ...json,
        themes: json.themes.map((t) =>
          t.themeId === "industry_contour" ? { ...t, domains: "metalltrade\\.ru" } : t
        ),
      },
      { source: "override", overridePath: EXAMPLE_PATH }
    );
    const industry = compiled.themes.find((t) => t.themeId === "industry_contour")!;
    expect(industry.domains?.test("https://metalltrade.ru/news/1")).toBe(true);
    expect(industry.domains?.test("https://example.ru/metalltrade-review")).toBe(false);
  });
});
