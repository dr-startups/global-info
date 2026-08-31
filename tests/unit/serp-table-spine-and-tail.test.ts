/**
 * Позвоночник — чтение поисковика, хвост — второй замер той же выдачи.
 *
 * Прогон 91, `YANDEX/RU`, запрос «Кремлев Умар Назарович»: собственный API
 * Яндекса вернул 16 строк, обогатитель — двадцать. Дека печатала шестнадцать и
 * выбрасывала 123 органических наблюдения из 602 по имени измерителя; три
 * страницы при этом объявляли клиенту потерю 26 позиций, лежащих в бандле.
 *
 * Решение владельца от 31.08.2026 (вариант «а»): позиции берутся у чтения
 * поисковика, недостающие номера добираются вторым чтением, а материалы
 * второго чтения, чей номер занят **другим** материалом позвоночника, уезжают
 * в таблицу Б — столбец «№» остаётся одной шкалой.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_EXTRA_TABLE_HEADERS,
  SERP_TABLE_HEADERS,
  buildSerpFragment,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import { serpPrintMatchesObservations } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const QUERY = "Кремлев Умар Назарович";

/** Строка корпуса: позиция, её измеритель и, если чтений два, оба номера. */
type Row = {
  rank: number;
  host: string;
  source: "yandex" | "arsenkin";
  ranksByProvider?: Record<string, number>;
};

/**
 * Форма прогона 91: шестнадцать позиций Яндекса, девять — обогатителя.
 *
 * Позиция 17 обогатителя — тот же материал, что у Яндекса пятнадцатый
 * (`rutube.ru`), поэтому строкой она не приходит: слияние сбора свело их в одно
 * наблюдение и оставило оба номера в `ranksByProvider`.
 */
function run91Rows(): Row[] {
  const spineHosts = [
    "umarkremlev.com", "ru.ruwiki.ru", "yandex.ru", "t.me", "vk.ru",
    "tass.ru", "ria.ru", "ruskrest.ru", "globalmsk.ru", "serpuhov.ru",
    "youtube.com", "championat.com", "rusprofile.ru", "gazeta.ru", "rutube.ru",
    "ura.news",
  ];
  const spine: Row[] = spineHosts.map((host, i) => ({
    rank: i + 1,
    host,
    source: "yandex",
    // У пятнадцатого материала два чтения: Яндекс дал 15, обогатитель — 17.
    ...(host === "rutube.ru" ? { ranksByProvider: { yandex: 15, arsenkin: 17 } } : {}),
  }));
  const tail: Row[] = [
    { rank: 18, host: "sportsdaily.ru", source: "arsenkin" },
    { rank: 19, host: "infosport.ru", source: "arsenkin" },
    { rank: 20, host: "sports.ru", source: "arsenkin" },
  ];
  // Материалы второго чтения, чьи номера заняты другими материалами Яндекса.
  const disputed: Row[] = [
    { rank: 4, host: "vk-umar.ru", source: "arsenkin" },
    { rank: 11, host: "tiktok.com", source: "arsenkin" },
    { rank: 12, host: "rostov.plus.rbc.ru", source: "arsenkin" },
    { rank: 13, host: "klerk.ru", source: "arsenkin" },
    { rank: 15, host: "74.ru", source: "arsenkin" },
    { rank: 16, host: "sport.rambler.ru", source: "arsenkin" },
  ];
  return [...spine, ...tail, ...disputed];
}

function scopedOf(rows: Row[], opts: { ranksByProvider?: boolean } = {}): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  rows.forEach((row, i) => {
    const ref = `i${i + 1}`;
    const byProvider = row.ranksByProvider ?? { [row.source]: row.rank };
    evidenceIndex[ref] = {
      title: `Материал ${row.host}`,
      url: `https://${row.host}/umar-kremlev`,
      domain: row.host,
      region: "RU",
      engine: "YANDEX",
      rank: row.rank,
      rankSource: row.source,
      ...(opts.ranksByProvider === false ? {} : { ranksByProvider: byProvider }),
      query: QUERY,
      queryPurpose: "subject_lookup",
      subjectNameQuery: true,
      subjectDecision: "SUBJECT_MATCH",
    };
    refs.push(ref);
  });
  return {
    findings: [],
    surfaceUnits: [{ surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs }],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function slidesOf(rows: Row[], opts?: { ranksByProvider?: boolean }): SlideContentContract[] {
  return buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scopedOf(rows, opts)).slides;
}

const isTableA = (s: SlideContentContract): boolean =>
  s.metrics?.serpPositional === 1 && s.metrics?.serpExtraQueries !== 1;
const isTableB = (s: SlideContentContract): boolean => s.metrics?.serpExtraQueries === 1;

function rowsOf(slides: SlideContentContract[]): string[][] {
  return slides.flatMap((s) => s.content.table?.rows ?? []);
}

function textOf(slides: SlideContentContract[]): string {
  return slides.map((s) => String(s.content.narrative ?? "")).join(" ");
}

/**
 * Корпус для ветки «занято»: материал, найденный **двумя** запросами.
 *
 * Материал, найденный несколькими запросами, здесь норма, а не исключение —
 * ради него живут `queriesOfRefs`, `bestRankForQuery` и колонка «Найдено по
 * запросу». Утверждение о выдаче по запросу X обязано выводиться из наблюдений
 * по запросу X: номер, намеренный по запросу Y, к странице X отношения не
 * имеет.
 */
const OTHER_QUERY = "Умар Кремлев";

function scopedTwoQueryMaterial(input: {
  /** По какому запросу материал получил третий номер. */
  thirdIn: "main" | "other";
}): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  const add = (ref: string, host: string, rank: number, query: string): void => {
    evidenceIndex[ref] = {
      title: `Материал ${host}`,
      url: `https://${host}/umar-kremlev`,
      domain: host,
      region: "RU",
      engine: "YANDEX",
      rank,
      rankSource: "yandex",
      ranksByProvider: { yandex: rank },
      query,
      queryPurpose: "subject_lookup",
      subjectNameQuery: query === QUERY,
      subjectDecision: "SUBJECT_MATCH",
    };
    refs.push(ref);
  };
  // Позвоночник главного запроса: 2, 4, 5 — номер 3 по нему не мерил никто.
  for (const [i, rank] of [2, 4, 5].entries()) add(`m${i}`, `main-${rank}.ru`, rank, QUERY);
  // Тот же материал под двумя запросами: первый номер по главному, третий — по
  // второму (или наоборот, если проверяем законную ветку).
  add("twoA", "dual.ru", input.thirdIn === "main" ? 3 : 1, QUERY);
  add("twoB", "dual.ru", input.thirdIn === "main" ? 1 : 3, OTHER_QUERY);
  return {
    findings: [],
    surfaceUnits: [{ surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs }],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

describe("«занята материалом» — только о номерах своего запроса", () => {
  it("номер, намеренный по другому запросу, занятым не считается", () => {
    /*
     * По главному запросу третьей позиции не мерил никто, а тот же материал
     * стоит третьим по второму запросу. Прежде номер утекал на страницу
     * главного, и лист говорил «занята» там, где верна вторая ветка.
     */
    const slides = buildSerpFragment(
      "RU_SERP",
      "RU_PROFILE",
      "Россия",
      scopedTwoQueryMaterial({ thirdIn: "other" })
    ).slides;
    const text = textOf(slides.filter(isTableA));
    expect(text).not.toContain("Позиция 3 занята");
    expect(text).toContain("не вернул ни один источник выдачи в этом прогоне");
  });

  it("номер, намеренный по своему запросу, занятым считается", () => {
    // Обратная сторона: материал напечатан первым по главному запросу, а по
    // нему же второе чтение намерило третий — вот это и есть «занято».
    const scoped = scopedTwoQueryMaterial({ thirdIn: "main" });
    const index = scoped.evidenceIndex as Record<string, Record<string, unknown>>;
    index.twoA!.rank = 1;
    index.twoA!.ranksByProvider = { yandex: 1, arsenkin: 3 };
    index.twoB!.rank = 9;
    index.twoB!.ranksByProvider = { yandex: 9 };
    const text = textOf(
      buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides.filter(isTableA)
    );
    expect(text).toContain("Позиция 3 занята материалом, показанным выше под другим номером");
  });
});

describe("состав таблицы А", () => {
  const slides = slidesOf(run91Rows());
  const tableA = slides.filter(isTableA);
  const rankColumn = SERP_TABLE_HEADERS.indexOf("№");
  const printed = rowsOf(tableA).map((r) => Number(r[rankColumn]));

  it("позвоночник и хвост напечатаны, спорные номера — нет", () => {
    expect(printed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20]);
  });

  it("столбец «№» — одна шкала: двух одинаковых номеров нет", () => {
    expect(new Set(printed).size).toBe(printed.length);
  });

  it("хвост печатается своим материалом", () => {
    const cells = rowsOf(tableA).map((r) => r.join(" "));
    expect(cells.join(" | ")).toContain("sportsdaily.ru");
    expect(cells.join(" | ")).toContain("infosport.ru");
    expect(cells.join(" | ")).toContain("sports.ru");
  });
});

describe("спорные материалы уезжают в таблицу Б", () => {
  const slides = slidesOf(run91Rows());

  it("все шесть напечатаны второй таблицей", () => {
    const cells = rowsOf(slides.filter(isTableB)).map((r) => r.join(" ")).join(" | ");
    for (const host of ["vk-umar.ru", "tiktok.com", "rostov.plus.rbc.ru", "klerk.ru", "74.ru", "sport.rambler.ru"]) {
      expect(cells).toContain(host);
    }
  });

  it("подпись таблицы Б называет второй замер, а не только другие запросы", () => {
    // Без этой оговорки таблица Б врёт о происхождении шести строк: их нашёл
    // не другой запрос, а другой замер той же выдачи.
    expect(textOf(slides.filter(isTableB))).toContain("другой замер той же выдачи");
  });

  it("потолок «всего остального» их не режет", () => {
    /*
     * Потолок таблицы Б держит хвост неоцененных материалов, а вытесненный из
     * таблицы А — часть обещанной двадцатки: его позицию прогон намерил внутри
     * ТОП-20 главного запроса. Замер на прогоне 91 до этой правки: 75
     * кандидатов, остаток 46, и все шесть вытесненных не печатались нигде —
     * ворот сверки называл их поимённо.
     */
    const filler: Row[] = Array.from({ length: 40 }, (_, i) => ({
      rank: 1,
      host: `filler-${i}.ru`,
      source: "yandex" as const,
    }));
    // Материалы-наполнители другого запроса: они и создают потолок.
    const scoped = scopedOf([...run91Rows()]);
    const index = scoped.evidenceIndex as Record<string, Record<string, unknown>>;
    /*
     * Вытесненные материалы найдены **и** вторым запросом.
     *
     * Без этого у них `extraQueries.length === 0`, кандидат строится ветвью
     * «пришёл только из таблицы А», где признак записан константой, и вторая
     * половина правки не исполняется вовсе. Ровно так она и оказалась
     * незакреплённой: батарея зелёная, а на живых данных теряется восемь
     * собранных материалов.
     */
    const displacedHosts = ["vk-umar.ru", "tiktok.com", "rostov.plus.rbc.ru", "klerk.ru", "74.ru", "sport.rambler.ru"];
    displacedHosts.forEach((host, i) => {
      const ref = `dual${i}`;
      index[ref] = {
        title: `Материал ${host}`,
        url: `https://${host}/umar-kremlev`,
        domain: host,
        region: "RU",
        engine: "YANDEX",
        rank: 7 + i,
        rankSource: "arsenkin",
        ranksByProvider: { arsenkin: 7 + i },
        query: "умар кремлев рольф",
        queryPurpose: "subject_lookup",
        subjectDecision: "SUBJECT_MATCH",
      };
      (scoped.surfaceUnits[0]!.evidenceRefs as string[]).push(ref);
    });
    filler.forEach((row, i) => {
      const ref = `f${i}`;
      index[ref] = {
        title: `Наполнитель ${i}`,
        url: `https://${row.host}/x`,
        domain: row.host,
        region: "RU",
        engine: "YANDEX",
        rank: (i % 20) + 1,
        rankSource: "yandex",
        ranksByProvider: { yandex: (i % 20) + 1 },
        query: "умар кремлев рольф",
        queryPurpose: "subject_lookup",
        subjectDecision: "SUBJECT_MATCH",
      };
      (scoped.surfaceUnits[0]!.evidenceRefs as string[]).push(ref);
    });
    const slides = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides;
    const cells = rowsOf(slides.filter(isTableB)).map((r) => r.join(" ")).join(" | ");
    for (const host of ["vk-umar.ru", "tiktok.com", "rostov.plus.rbc.ru", "klerk.ru", "74.ru", "sport.rambler.ru"]) {
      expect(cells).toContain(host);
    }
  });

  it("колонка «Найдено по запросу» у них заполнена", () => {
    const col = SERP_EXTRA_TABLE_HEADERS.indexOf("Найдено по запросу");
    for (const row of rowsOf(slides.filter(isTableB))) {
      expect(String(row[col] ?? "").trim()).not.toBe("");
    }
  });
});

describe("пропуск номера объясняется данными, а не общей оговоркой", () => {
  it("занятый номер назван занятым", () => {
    const text = textOf(slidesOf(run91Rows()).filter(isTableA));
    expect(text).toContain("Позиция 17 занята материалом, показанным выше под другим номером");
    expect(text).not.toContain("не вернул ни один источник");
  });

  it("номер, которого нет ни у одного чтения, назван своими словами", () => {
    // Форма таблицы GOOGLE/UAE «Umar Kremlev» прогона 91: пропуски 1, 4 и 9
    // не объясняются ничем, кроме того, что источники их не вернули.
    const rows: Row[] = [2, 3, 5, 6, 7, 8, 10].map((rank) => ({
      rank,
      host: `main-${rank}.ru`,
      source: "yandex",
    }));
    const text = textOf(slidesOf(rows).filter(isTableA));
    expect(text).toContain("Позиции 1, 4, 9, 11–20 не вернул ни один источник выдачи в этом прогоне");
    expect(text).not.toContain("занята материалом");
  });

  it("общей оговорки о пропуске в дереве нет", () => {
    // Правило «пропуск номера не означает пустоту в выдаче» отменено замером:
    // на таблице GOOGLE/UAE «Umar Kremlev» оно встало бы над пропусками 1, 4
    // и 9, где именно это и означает.
    const text = textOf(slidesOf(run91Rows()));
    expect(text).not.toContain("пропуск номера не означает");
  });

  it("полная двадцатка объяснений не требует", () => {
    const rows: Row[] = Array.from({ length: 20 }, (_, i) => ({
      rank: i + 1,
      host: `main-${i + 1}.ru`,
      source: "yandex" as const,
    }));
    const text = textOf(slidesOf(rows).filter(isTableA));
    expect(text).not.toContain("занята материалом");
    expect(text).not.toContain("не вернул ни один источник");
  });

  it("набор без второго чтения о занятых номерах молчит", () => {
    /*
     * Прогоны, снятые до проводки поля, первую ветку исполнить не могут.
     * Признак — свойство **набора**, а не пустота поля отдельной строки:
     * недоехавшее поле превратило бы «занято материалом выше» в «не вернул ни
     * один источник» — новую ложь на месте старой, притом правдоподобную.
     */
    const text = textOf(slidesOf(run91Rows(), { ranksByProvider: false }).filter(isTableA));
    expect(text).not.toContain("занята материалом");
    expect(text).not.toContain("не вернул ни один источник");
    expect(text).toContain("Поисковик вернул по этому запросу");
  });
});

describe("ворот сверки печати с наблюдениями на этой деке молчит", () => {
  it("после работы 9 не потеряно ни одного материала", () => {
    /*
     * Главный прибор партии: до работы 9 на этой же форме он называл семь
     * материалов, не доехавших до отчёта. Ноль здесь означает, что каждая
     * собранная строка напечатана — в таблице А своим номером либо в таблице Б.
     */
    const slides = slidesOf(run91Rows());
    const rendererSlides: RendererSlide[] = slides.map((s) => ({
      slideKey: s.slideId,
      sectionKey: "RU_PROFILE",
      template: "orion_golden_search_table",
      templateId: s.templateId,
      title: s.title,
      pageNumber: 1,
      totalPageCount: slides.length,
      baseSlotId: s.baseSlotId,
      isContinuation: s.isContinuation,
      table: s.content.table,
      evidenceRefs: s.evidenceRefs,
      findingIds: [],
      metrics: s.metrics,
      visualAssetRefs: [],
      staticBlocks: [],
    })) as unknown as RendererSlide[];
    const observations = run91Rows().map((row) => ({
      surface: "organic",
      engine: "YANDEX",
      region: "RU",
      query: QUERY,
      rank: row.rank,
      rankSource: row.source,
      url: `https://${row.host}/umar-kremlev`,
      domain: row.host,
      title: `Материал ${row.host}`,
    }));
    const result = serpPrintMatchesObservations({ rendererSlides, observations });
    expect(result.skipped).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});
