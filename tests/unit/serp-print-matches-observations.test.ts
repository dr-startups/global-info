/**
 * Ворота: печатная таблица выдачи сверяется с артефактом наблюдений.
 *
 * Мерить таблицу тем же индексом доказательств, которым она собрана,
 * бессмысленно — сломанный сбор согласится сам с собой. Поэтому проверка
 * читает наблюдения напрямую и смотрит в обе стороны: каждый напечатанный
 * номер подтверждён наблюдением своего движка по запросу таблицы, и каждое
 * такое наблюдение с позицией не глубже двадцатой напечатано.
 *
 * На печати прогона 76 проверка обязана быть красной с обеих сторон:
 * арсенкинские 11–20 не подтверждаются, серперные 3, 4 и 10 не напечатаны.
 */

import { describe, expect, it } from "vitest";
import {
  serpPrintMatchesObservations,
  validateAssembly,
} from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import {
  SERP_EXTRA_TABLE_HEADERS,
  SERP_TABLE_HEADERS,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { SerpObservationRow } from "../fixtures/run76-serp-slice";
import { run76SerperRows, run76ArsenkinRows, UAE_QUERY } from "../fixtures/run76-serp-slice";

/** Страница выдачи: номера строк плюс движок и запрос, записанные данными. */
function serpSlide(input: {
  engine: string;
  query: string;
  ranks: number[];
  links?: Record<number, string>;
  slideKey?: string;
  /** Номера строк — позиции выдачи; иначе это порядок сбора. */
  positional?: boolean;
  /** Регион таблицы ворота читают из секции слайда. */
  sectionKey?: string;
}): RendererSlide {
  return {
    slideKey: input.slideKey ?? "p09_uae_serp",
    sectionKey: input.sectionKey ?? "UAE_PROFILE",
    template: "orion_golden_search_table",
    templateId: "serp-table",
    title: "ОАЭ — Google, ТОП-20",
    pageNumber: 9,
    totalPageCount: 9,
    baseSlotId: "p09_uae_serp",
    isContinuation: false,
    table: {
      // Адрес строки — её колонка «Ссылка»: ворота читают домен оттуда же,
      // откуда его читает клиент. Позицию они берут из колонки «№», и обе
      // находятся по именам, а не по местам.
      headers: [...SERP_TABLE_HEADERS],
      rows: input.ranks.map((rank) => [
        String(rank),
        input.links?.[rank] ?? `example.org/${rank}`,
        `Материал ${rank}`,
        "СМИ",
        "Нейтральный",
      ]),
    },
    evidenceRefs: [],
    findingIds: [],
    metrics: {
      serpEngine: input.engine,
      serpQuery: input.query,
      serpPositional: input.positional === false ? 0 : 1,
    },
    visualAssetRefs: [],
    staticBlocks: [],
  };
}

/**
 * Лист «найдено по дополнительным запросам»: у него нет колонки «№», а адреса
 * есть. Материал, доехавший сюда, потерянным не считается.
 */
function extraTableSlide(input: {
  addresses: string[];
  sectionKey?: string;
  slideKey?: string;
}): RendererSlide {
  const address = SERP_EXTRA_TABLE_HEADERS.indexOf("Ссылка");
  return {
    slideKey: input.slideKey ?? "p24_ru_serp_extra",
    sectionKey: input.sectionKey ?? "RU_PROFILE",
    template: "orion_golden_search_table",
    templateId: "serp-table",
    title: "Россия — найдено по дополнительным запросам",
    pageNumber: 24,
    totalPageCount: 30,
    baseSlotId: "p24_ru_serp_extra",
    isContinuation: false,
    table: {
      headers: [...SERP_EXTRA_TABLE_HEADERS],
      rows: input.addresses.map((link) => {
        const row = ["", "", "«Умар Кремлев»", "СМИ", "Нейтральный"];
        row[address] = link;
        row[SERP_EXTRA_TABLE_HEADERS.indexOf("Заголовок")] = "Материал по доп. запросу";
        return row;
      }),
    },
    evidenceRefs: [],
    findingIds: [],
    metrics: { serpPositional: 0 },
    visualAssetRefs: [],
    staticBlocks: [],
  };
}

function linksOf(rows: SerpObservationRow[]): Record<number, string> {
  return Object.fromEntries(rows.map((r) => [r.rank!, `${r.domain}/viktor-rashnikov`]));
}

describe("печать сверяется с наблюдениями", () => {
  it("строка, которую не подтверждает ни одно наблюдение, называется", () => {
    const rows = [...run76SerperRows(), ...run76ArsenkinRows()];
    // Печать прогона 76: серперные 1, 2, 5–9 плюс арсенкинские 4, 10 и 11–20.
    // Своих адресов у семи серперных строк на листе не оказалось, и позиция 3
    // (opensanctions.org) не напечатана вовсе — обе потери ворота обязаны
    // назвать. Номера обогатителя чужими больше не считаются: движок и запрос
    // у них те же, и решает принадлежность именно это.
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
          links: linksOf(run76ArsenkinRows()),
        }),
      ],
      observations: rows,
    });
    expect(result.issues.join(" | ")).toContain("example.org");
    expect(result.issues.join(" | ")).toContain("opensanctions.org");
    expect(result.issues.some((i) => i.includes("kommersant.ru"))).toBe(false);
    expect(result.skipped).toEqual([]);
  });

  it("потерянное наблюдение своего движка называется строкой", () => {
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 5, 6, 7, 8, 9],
          links: linksOf(run76SerperRows()),
        }),
      ],
      observations: run76SerperRows(),
    });
    // Не напечатаны 3 (opensanctions.org), 4 (bloomberg.com), 10 (wikidata.org).
    expect(result.issues.join(" ")).toContain("opensanctions.org");
    expect(result.issues.length).toBe(3);
  });

  it("честная печать всей собранной двадцатки проходит", () => {
    // Своих десять позиций Serper плюс хвост обогатителя: собрано двадцать,
    // напечатано двадцать. Позиции 4 и 10 у обогатителя свои, но места заняты
    // серперными — это допустимая потеря «дубль позиции».
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
          links: { ...linksOf(run76ArsenkinRows()), ...linksOf(run76SerperRows()) },
        }),
        // Позиции 4 и 10 у обогатителя свои, места заняты серперными строками —
        // эти два материала доезжают до клиента второй таблицей региона.
        extraTableSlide({
          addresses: ["metalinfo.ru/viktor-rashnikov", "ko.ru/viktor-rashnikov"],
          sectionKey: "UAE_PROFILE",
          slideKey: "p12_uae_serp_extra",
        }),
      ],
      observations: [...run76SerperRows(), ...run76ArsenkinRows()],
    });
    expect(result.issues).toEqual([]);
  });

  it("строка без своего адреса — отказ, а не молчаливый пропуск", () => {
    /*
     * Домен строки ворота берут из полосы адреса. Полосы нет — сверять нечем,
     * и ворота обязаны сказать это вслух: молчаливый пропуск сделал бы их
     * вакуумно зелёными ровно там, где печать перестала называть источник.
     */
    const slide = serpSlide({
      engine: "GOOGLE",
      query: UAE_QUERY,
      ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      links: linksOf(run76SerperRows()),
    });
    // Колонка адреса пуста: печать перестала называть источник.
    const addressColumn = SERP_TABLE_HEADERS.indexOf("Ссылка");
    for (const row of slide.table!.rows) row[addressColumn] = "";
    const result = serpPrintMatchesObservations({
      rendererSlides: [slide],
      observations: run76SerperRows(),
    });
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.join(" | ")).toContain("без адреса");
  });

  it("регистр написания запроса ворота не смущает", () => {
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: "Viktor Rashnikov",
          ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          links: linksOf(run76SerperRows()),
        }),
      ],
      observations: run76SerperRows(),
    });
    expect(result.issues).toEqual([]);
  });

  it("занятая позиция сама по себе потерю не прощает", () => {
    /*
     * Вопрос ворота — «доехал ли материал», а не «напечатан ли номер». Две
     * третьих строки в выдаче невозможны, но материал, вытесненный дублем и
     * не напечатанный больше нигде, до клиента не доехал: раньше его прощало
     * правило «номер занят», и на прогоне 91 так молча прощались четыре
     * материала ТОП-20, которых в деке нет вовсе.
     */
    const twin: SerpObservationRow = {
      ...run76SerperRows()[2]!,
      observationKey: "twin",
      url: "https://dubletest.ru/3",
      domain: "dubletest.ru",
      title: "Дубль третьей позиции",
      evidenceRefs: ["inventory:obs-twin"],
    };
    const tableA = serpSlide({
      engine: "GOOGLE",
      query: UAE_QUERY,
      ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      links: linksOf(run76SerperRows()),
    });
    const lost = serpPrintMatchesObservations({
      rendererSlides: [tableA],
      observations: [...run76SerperRows(), twin],
    });
    expect(lost.issues.join(" | ")).toContain("dubletest.ru/3");

    // Тот же дубль, доехавший до второй таблицы своего региона, — не потеря.
    const arrived = serpPrintMatchesObservations({
      rendererSlides: [
        tableA,
        extraTableSlide({ addresses: ["dubletest.ru/3"], sectionKey: "UAE_PROFILE" }),
      ],
      observations: [...run76SerperRows(), twin],
    });
    expect(arrived.issues).toEqual([]);
  });

  it("маркер «ничего не найдено» строкой таблицы быть не обязан", () => {
    const marker: SerpObservationRow = {
      ...run76SerperRows()[0]!,
      observationKey: "marker",
      rank: 11,
      url: undefined,
      domain: undefined,
      title: "Ничего не найдено",
      evidenceRefs: ["inventory:obs-marker"],
    };
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          links: linksOf(run76SerperRows()),
        }),
      ],
      observations: [...run76SerperRows(), marker],
    });
    expect(result.issues).toEqual([]);
  });

  it("непозиционная таблица воротами не сверяется", () => {
    /*
     * У движка не оказалось ни одной своей позиции — таблица честно
     * вырождается в «собранную выдачу», и её номера это порядок сбора, а не
     * места в выдаче. Прочитанные как позиции, они дали бы «позиция N не
     * подтверждена» на каждой строке и уронили бы приёмку здорового прогона.
     */
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 3],
          positional: false,
        }),
      ],
      observations: run76SerperRows(),
    });
    expect(result.issues).toEqual([]);
    expect(result.skipped.join(" ")).toContain("позиционных таблиц");
  });

  it("набор без источника позиции ворота больше не останавливает", () => {
    /*
     * Пропуск «в наблюдениях нет поля rankSource» существовал ровно затем,
     * чтобы фильтр ожидаемого набора не обнулил его на старом наборе. Фильтра
     * нет — и мерить такой набор больше ничто не мешает: принадлежность
     * позиции таблице решают движок и запрос, а они есть и у старых строк.
     */
    const rows = run76SerperRows().map((r) => ({ ...r, rankSource: undefined }));
    const whole = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          links: linksOf(rows),
        }),
      ],
      observations: rows,
    });
    expect(whole.issues).toEqual([]);
    expect(whole.skipped).toEqual([]);

    const partial = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({ engine: "GOOGLE", query: UAE_QUERY, ranks: [1, 2, 3], links: linksOf(rows) }),
      ],
      observations: rows,
    });
    expect(partial.issues.join(" | ")).toContain("wikidata.org");
    expect(partial.skipped).toEqual([]);
  });
});

describe("«сверка состоялась» — это данные, а не строка сообщения", () => {
  it("сверка называет число сверенных таблиц", () => {
    // Признак «проверка выполнялась» обязан браться из того, что она сделала.
    // Пока им служило отсутствие строки в `skipped`, снятая строка сообщения
    // возвращала вакуумный проход: ключ появлялся, и ему верили.
    const compared = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          links: linksOf(run76SerperRows()),
        }),
      ],
      observations: run76SerperRows(),
    });
    expect(compared.comparedTables).toBe(1);
    expect(compared.issues).toEqual([]);
  });

  it("непозиционная дека сверяет ноль таблиц", () => {
    const none = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({ engine: "GOOGLE", query: UAE_QUERY, ranks: [1, 2, 3], positional: false }),
      ],
      observations: run76SerperRows(),
    });
    expect(none.comparedTables).toBe(0);
    expect(none.issues).toEqual([]);
  });
});

describe("отчёт сборки несёт объявленный пропуск", () => {
  it("пропущенная сверка не отчитывается пройденной", () => {
    const report = validateAssembly({
      manifest: { sectionOrder: [], entries: [] },
      deckManifest: {
        caseId: "case-1",
        sourceDatasetId: "dataset-1",
        pageCount: 1,
        baseSlotCoverage: 36,
        sectionPageRanges: [],
        toc: [],
        nonCanonicalPages: [],
        slides: [
          {
            slideId: "p09_uae_serp",
            baseSlotId: "p09_uae_serp",
            templateId: "serp-table",
            pageNumber: 1,
            isContinuation: false,
            pageKind: "canonical_base",
          },
        ],
      },
      rendererSlides: [
        serpSlide({ engine: "GOOGLE", query: UAE_QUERY, ranks: [1, 2, 3], positional: false }),
      ],
      packs: [],
      bundle: { findings: [] },
      baseObservationCountBefore: 0,
      baseObservationCountAfter: 0,
      serpObservations: run76SerperRows(),
    } as unknown as Parameters<typeof validateAssembly>[0]);
    // Пропуск — не проход: ключа проверки в отчёте нет вовсе, и сказано,
    // почему её не было. Ворот, отчитавшийся `true` о невыполненной сверке,
    // неотличим от работающего.
    expect(Object.keys(report.checks).filter((k) => /^serpTable/u.test(k))).toEqual([]);
    expect(report.checks.serpTableMatchesObservations).toBeUndefined();
    expect(report.skipped.join(" ")).toContain("позиционных таблиц");
  });
});

/**
 * Позицию таблице назначает движок и запрос, а не имя измерителя.
 *
 * Замер прогона 91 (YANDEX/RU, запрос «Кремлев Умар Назарович»): собственный
 * API Яндекса вернул 16 строк, обогатитель — двадцать. Напечатаны 1–16;
 * материалы позиций 18, 19 и 20 не напечатаны нигде, а ворота при этом отдали
 * ноль замечаний и ноль пропусков — потому что ожидаемый набор фильтровался
 * тем же предикатом `rankSourceBelongsToEngine`, что и построитель. Прибор
 * мерил тем, что создаёт дефект.
 *
 * Ожидание ворот обязано быть слепо к решениям построителя: это все
 * органические наблюдения движка и запроса таблицы с позицией не глубже
 * двадцатой, кто бы их ни измерил.
 */
const RU_QUERY = "Кремлев Умар Назарович";

function ruRow(input: {
  rank: number;
  domain: string;
  rankSource: "yandex" | "arsenkin";
  query?: string | undefined;
}): SerpObservationRow {
  const query = "query" in input ? input.query : RU_QUERY;
  return {
    observationKey: `ru|${input.domain}|${input.rankSource}|${input.rank}`,
    provider: input.rankSource,
    providers: [input.rankSource],
    engine: "YANDEX",
    surface: "organic",
    region: "RU",
    url: `https://${input.domain}/umar-kremlev`,
    title: `Умар Кремлев — ${input.domain}`,
    domain: input.domain,
    rank: input.rank,
    rankSource: input.rankSource,
    ...(query === undefined ? {} : { query }),
    queryPurpose: "subject_lookup",
    evidenceRefs: [`inventory:obs-ru-${input.rankSource}-${input.rank}`],
    provenanceOwner: input.rankSource === "yandex" ? "base" : "enrichment",
  };
}

/** Шестнадцать строк, которые вернул собственный API Яндекса. */
function yandexOwnRows(): SerpObservationRow[] {
  const domains = [
    "umarkremlev.com", "ru.ruwiki.ru", "yandex.ru", "t.me", "vk.ru",
    "tass.ru", "ria.ru", "ruskrest.ru", "globalmsk.ru", "serpuhov.ru",
    "youtube.com", "championat.com", "rusprofile.ru", "gazeta.ru", "rutube.ru",
    "ura.news",
  ];
  return domains.map((domain, i) =>
    ruRow({ rank: i + 1, domain, rankSource: "yandex" })
  );
}

/** Хвост двадцатки, который принёс обогатитель: 18, 19 и 20. */
function arsenkinTailRows(): SerpObservationRow[] {
  return [
    ruRow({ rank: 18, domain: "sportsdaily.ru", rankSource: "arsenkin" }),
    ruRow({ rank: 19, domain: "infosport.ru", rankSource: "arsenkin" }),
    ruRow({ rank: 20, domain: "sports.ru", rankSource: "arsenkin" }),
  ];
}

function ruSlide(rows: SerpObservationRow[], ranks: number[]): RendererSlide {
  const links = Object.fromEntries(
    rows.filter((r) => r.rank != null).map((r) => [r.rank!, `${r.domain}/umar-kremlev`])
  );
  return serpSlide({
    engine: "YANDEX",
    query: RU_QUERY,
    ranks,
    links,
    slideKey: "p22_ru_serp_table",
    sectionKey: "RU_PROFILE",
  });
}

describe("позиция обогатителя — позиция той же выдачи", () => {
  const printedSixteen = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

  it("собранный хвост двадцатки, не доехавший до листа, назван строкой", () => {
    const rows = [...yandexOwnRows(), ...arsenkinTailRows()];
    const result = serpPrintMatchesObservations({
      rendererSlides: [ruSlide(yandexOwnRows(), printedSixteen)],
      observations: rows,
    });
    expect(result.skipped).toEqual([]);
    expect(result.issues).toHaveLength(3);
    expect(result.issues.join(" | ")).toContain("sportsdaily.ru");
    expect(result.issues.join(" | ")).toContain("infosport.ru");
    expect(result.issues.join(" | ")).toContain("sports.ru");
  });

  it("хвост, доехавший до второй таблицы региона, потерей не считается", () => {
    // Правило плана: материал обязан найтись либо в таблице своей пары
    // «движок × запрос», либо в таблице региона по колонке «Ссылка».
    const rows = [...yandexOwnRows(), ...arsenkinTailRows()];
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        ruSlide(yandexOwnRows(), printedSixteen),
        extraTableSlide({
          addresses: arsenkinTailRows().map((r) => `${r.domain}/umar-kremlev`),
        }),
      ],
      observations: rows,
    });
    expect(result.issues).toEqual([]);
  });

  it("вторая таблица чужого региона потерю не прощает", () => {
    // Регион — единица счёта: материал, напечатанный на листе ОАЭ, до
    // российской страницы не доехал.
    const rows = [...yandexOwnRows(), ...arsenkinTailRows()];
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        ruSlide(yandexOwnRows(), printedSixteen),
        extraTableSlide({
          addresses: arsenkinTailRows().map((r) => `${r.domain}/umar-kremlev`),
          sectionKey: "UAE_PROFILE",
          slideKey: "p50_uae_serp_extra",
        }),
      ],
      observations: rows,
    });
    expect(result.issues).toHaveLength(3);
  });

  it("материал, вытесненный с занятой позиции, прощается только доехавшим", () => {
    /*
     * Форма прогона 91: у обогатителя 15-я строка своя (74.ru), место занято
     * строкой Яндекса. Материал доехал до второй таблицы региона — потери нет;
     * тот же материал, не напечатанный нигде, обязан быть назван.
     */
    const rows = [
      ...yandexOwnRows(),
      ruRow({ rank: 15, domain: "74.ru", rankSource: "arsenkin" }),
    ];
    const tableA = ruSlide(yandexOwnRows(), printedSixteen);
    const arrived = serpPrintMatchesObservations({
      rendererSlides: [tableA, extraTableSlide({ addresses: ["74.ru/umar-kremlev"] })],
      observations: rows,
    });
    expect(arrived.issues).toEqual([]);

    const lost = serpPrintMatchesObservations({
      rendererSlides: [tableA],
      observations: rows,
    });
    expect(lost.issues).toHaveLength(1);
    // Адрес, позиция и имя измерителя — по строке видно, что искать и кто мерил.
    expect(lost.issues[0]).toContain("74.ru/umar-kremlev");
    expect(lost.issues[0]).toContain("15");
    expect(lost.issues[0]).toContain("arsenkin");
  });

  it("адрес второй таблицы сравнивается целиком, а не одним доменом", () => {
    // Иначе строка «vk.ru» второй таблицы прощала бы `vk.ru/umar_kremlev`,
    // которого в деке нет: на прогоне 91 таких материалов было четыре.
    const rows = [
      ...yandexOwnRows(),
      ruRow({ rank: 15, domain: "vk.ru", rankSource: "arsenkin" }),
    ];
    const bareDomainOnly = serpPrintMatchesObservations({
      rendererSlides: [
        ruSlide(yandexOwnRows(), printedSixteen),
        extraTableSlide({ addresses: ["vk.ru"] }),
      ],
      observations: rows.map((r) =>
        r.rankSource === "arsenkin" ? { ...r, url: "https://vk.ru/umar_kremlev" } : r
      ),
    });
    expect(bareDomainOnly.issues.join(" | ")).toContain("vk.ru/umar_kremlev");
  });

  it("обрезанный многоточием адрес второй таблицы засчитывается началом", () => {
    // `clientLink` режет адрес длиннее 165 знаков и ставит многоточие; целый
    // адрес наблюдения обязан узнаваться по напечатанному началу.
    const long = `rostov.plus.rbc.ru/news/${"a".repeat(200)}`;
    const rows = [
      ...yandexOwnRows(),
      { ...ruRow({ rank: 18, domain: "rostov.plus.rbc.ru", rankSource: "arsenkin" }), url: `https://${long}` },
    ];
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        ruSlide(yandexOwnRows(), printedSixteen),
        extraTableSlide({ addresses: [`${long.slice(0, 164)}…`] }),
      ],
      observations: rows,
    });
    expect(result.issues).toEqual([]);
  });

  it("напечатанный хвост обогатителя подтверждён наблюдением", () => {
    const rows = [...yandexOwnRows(), ...arsenkinTailRows()];
    const result = serpPrintMatchesObservations({
      rendererSlides: [ruSlide(rows, [...printedSixteen, 18, 19, 20])],
      observations: rows,
    });
    expect(result.issues).toEqual([]);
  });

  it("наблюдение без записанного запроса в таблицу запроса не попадает", () => {
    // Защита прогона 76: у строки, пришедшей вторичной ингестией, запрос
    // стёрт, и её номер — не позиция этой таблицы. Ворота её не ждут…
    const orphan = ruRow({ rank: 18, domain: "sportsdaily.ru", rankSource: "arsenkin", query: undefined });
    const rows = [...yandexOwnRows(), orphan];
    expect(
      serpPrintMatchesObservations({
        rendererSlides: [ruSlide(yandexOwnRows(), printedSixteen)],
        observations: rows,
      }).issues
    ).toEqual([]);
    // …и напечатанной её тоже не подтверждают.
    const printed = serpPrintMatchesObservations({
      rendererSlides: [ruSlide(rows, [...printedSixteen, 18])],
      observations: rows,
    });
    expect(printed.issues.join(" | ")).toContain("не подтверждена наблюдением");
  });
});
