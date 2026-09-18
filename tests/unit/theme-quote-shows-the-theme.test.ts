/**
 * Цитата под темой показывает тему (шаг 0115).
 *
 * Отчёт Бондарчука 19.09.2026, «Политические связи / публичная экспозиция»:
 * «Председатель Правительства РФ.» (2x2.su — навигация сайта о Мишустине),
 * «Фёдор Сергеевич Бондарчук (род. 9 мая 1967, Москва, СССР) — советский и
 * российский актёр кино» (Википедия — лид статьи, а фраза с темой стояла
 * второй цитатой страницы). «Деловой профиль»: «Paulina Andreeva - Biography»
 * (imdb.com — о другом человеке). Владелец: «мы должны клиенту объяснять,
 * какой именно факт/риск отражен в статье».
 *
 * Правило: цитата под темой — та фраза материала, из-за которой материал в
 * теме: несёт сигнал темы, целая, о субъекте; цитата прочитанной страницы →
 * заголовок публикации → предложение сниппета; нет ни одной — цитаты нет.
 */

import { describe, expect, it } from "vitest";
import {
  pickClaimExamples,
  resolveExampleQuote,
  synthesizeFindings,
} from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { spreadVerdictsOverMaterials } from "@/modules/digital-profile/orion-golden/analytics/item-adverse";
import { getFindingThemes } from "@/modules/digital-profile/config/finding-themes";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { SubjectResolutionItem } from "@/modules/digital-profile/orion-golden/contracts/subject-resolution";
import type { ObservationVerdict } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";

const POLITICAL = getFindingThemes().find((t) => t.themeId === "political_exposure")!;
const BUSINESS = getFindingThemes().find((t) => t.themeId === "business_profile")!;
const OWNERSHIP = getFindingThemes().find((t) => t.themeId === "corporate_ownership")!;

const SUBJECT_NAMES = ["Бондарчук Фёдор Сергеевич"];

function item(partial: Partial<RawInventoryItem> & { inventoryId: string }): RawInventoryItem {
  return {
    caseId: "case-bondarchuk",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "topvisor-yandex",
    region: "RU",
    collectedAt: "2026-09-18T12:00:00.000Z",
    evidenceType: "search_result",
    title: "",
    snippet: "",
    ...partial,
  } as RawInventoryItem;
}

const WIKI_LEAD =
  "Фёдор Серге́евич Бондарчу́к (род. 9 мая 1967 , Москва , СССР ) — советский и российский актёр кино";
const WIKI_PARTY = "Член Высшего совета политической партии « Единая Россия » в 2009—2021 годах.";
const WIKI_SCHOOL =
  "Не отличался успешной учёбой и хорошим поведением, в школьные годы стал пить, курить и хулиганить";

const WIKI = item({
  inventoryId: "wiki",
  title: "Бондарчук, Фёдор Сергеевич — Википедия",
  snippet:
    "Фёдор Сергеевич Бондарчук (род. 9 мая 1967, Москва, СССР) — советский и российский актёр кино, " +
    "телевидения, озвучивания и дубляжа, режиссёр и продюсер кино и телевидения, сценарист, " +
    "телеведущий, ресторатор и клипмейкер. С 2012 по 2024 год — председатель совета директоров АО " +
    "«Ленфильм». Член Высшего совета политической партии «Единая Россия» в 2009—2021 годах.",
  sourceUrl: "https://ru.wikipedia.org/wiki/Бондарчук,_Фёдор_Сергеевич",
});

const WIKI_VERDICT: ObservationVerdict = {
  tone: "adverse",
  quoted: true,
  subjectMatch: "subject",
  quotes: [WIKI_LEAD, WIKI_PARTY, WIKI_SCHOOL],
};

/** Сниппет Яндекса кончается навигацией «Другие биографии» — о Мишустине. */
const TWO_BY_TWO = item({
  inventoryId: "2x2",
  title: "Бондарчук Фёдор Сергеевич - Биография - Дважды два",
  snippet:
    "Бондарчук Фёдор Сергеевич. Сын режиссёра, народного артиста СССР Сергея Фёдоровича Бондарчука и " +
    "актрисы, народной артистки РСФСР Ирины Константиновны Скобцевой. Есть старшая сестра Елена " +
    "Бондарчук. Окончил художественную школу и среднюю школу № 31 с английским уклоном. " +
    "Другие биографии. Мишустин Михаил Владимирович. Председатель Правительства РФ.",
  sourceUrl: "https://2x2.su/biography/bondarchuk-fyedor-sergeevich/",
});

describe("цитата под темой несёт сигнал темы и берётся со страницы первой", () => {
  it("Ц1: у Википедии с тремя цитатами страницы политическая тема цитирует фразу о партии, а не лид", () => {
    const ex = resolveExampleQuote(WIKI, POLITICAL, null, {
      subjectNames: SUBJECT_NAMES,
      verdict: WIKI_VERDICT,
    });
    expect(ex?.title).toContain("Единая Россия");
    expect(ex?.title).not.toContain("актёр кино");
  });

  it("Ц2: навигация сайта о другом человеке не даёт ни темы, ни цитаты", () => {
    const ex = resolveExampleQuote(TWO_BY_TWO, POLITICAL, null, { subjectNames: SUBJECT_NAMES });
    expect(ex).toBeNull();

    const result = synthesizeFindings({
      caseId: "case-bondarchuk",
      datasetId: "ds-1",
      items: [TWO_BY_TWO],
      resolutionByRef: new Map([
        [
          "inventory:2x2",
          { evidenceRef: "inventory:2x2", decision: "SUBJECT_MATCH" } as SubjectResolutionItem,
        ],
      ]),
      sourceHashes: [],
      subjectNames: SUBJECT_NAMES,
    });
    const themes = result.themeAssignments.get("inventory:2x2") ?? [];
    expect(themes).not.toContain("political_exposure");
    expect(themes).toContain("business_profile");
  });

  it("Ц3: подпись из двух слов не цитата, целое предложение с сигналом — цитата", () => {
    const card = item({
      inventoryId: "datanewton",
      title: "Бондарчук Федор Сергеевич - ИНН 772507293305 - Москва",
      snippet: "Владелец ИП. ИНН 772507293305. Регион: Москва.",
      sourceUrl: "https://datanewton.ru/person/772507293305",
    });
    expect(resolveExampleQuote(card, OWNERSHIP, null, { subjectNames: SUBJECT_NAMES })).toBeNull();

    const press = item({
      inventoryId: "mk",
      title: "Фёдор Бондарчук — MK.RU",
      snippet:
        "Является сооснователем и владельцем одной из крупнейших кинокомпаний России «Art Pictures Studio».",
      sourceUrl: "https://www.mk.ru/persons/fedor-bondarchuk",
    });
    const ex = resolveExampleQuote(press, OWNERSHIP, null, { subjectNames: SUBJECT_NAMES });
    expect(ex?.title).toContain("сооснователем и владельцем");
  });

  it("Ц4: заголовок о другом человеке и заголовок без сигнала цитатами не становятся", () => {
    const imdb = item({
      inventoryId: "imdb",
      title: "Paulina Andreeva - Biography - IMDb",
      snippet: "IMDb",
      sourceUrl: "https://www.imdb.com/name/nm1234567/bio/",
      region: "UAE",
    });
    expect(resolveExampleQuote(imdb, BUSINESS, null, { subjectNames: SUBJECT_NAMES })).toBeNull();

    const filmmaker = item({
      inventoryId: "filmmaker",
      title: "Fyodor Bondarchuk on Stalingrad",
      snippet:
        "27 Feb 2014 — Politics were set aside for this brief interview, which focused on the " +
        "tremendous challenges of making the first Russian film since the USSR's ...",
      sourceUrl: "https://filmmakermagazine.com/84703-fyodor-bondarchuk-on-stalingrad/",
      region: "UAE",
    });
    expect(
      resolveExampleQuote(filmmaker, POLITICAL, null, { subjectNames: SUBJECT_NAMES })
    ).toBeNull();
  });

  it("Ц4б: имя площадки в хвосте заголовка — не другой человек", () => {
    // Эталон-72: «… - Highways Today» и «… - Аргументы Недели» — два слова с
    // заглавной в последнем сегменте, но это подпись издания, а не человек.
    const glinka = ["Глинка Сергей Александрович"];
    const highways = item({
      inventoryId: "highways",
      title: "Biography of Glinka Sergei - A Transportation Pioneer Few Heard Of - Highways Today",
      snippet: "",
      sourceUrl: "https://highways.today/glinka-sergei",
      region: "UAE",
    });
    expect(resolveExampleQuote(highways, BUSINESS, null, { subjectNames: glinka })?.title).toContain(
      "Biography of Glinka Sergei"
    );
    const argumenti = item({
      inventoryId: "argumenti",
      title:
        "Бизнесмен Сергей Глинка - биография, личная жизнь и взгляд на тренды общественного транспорта - Аргументы Недели",
      snippet: "",
      sourceUrl: "https://argumenti.ru/glinka",
    });
    expect(resolveExampleQuote(argumenti, BUSINESS, null, { subjectNames: glinka })?.title).toContain(
      "Бизнесмен Сергей Глинка"
    );
  });

  it("Ц5: цитата страницы, чья принадлежность не ясна, не печатается; заголовок с именем и сигналом — печатается", () => {
    const home = item({
      inventoryId: "stuki",
      title: "Федор Бондарчук - биография, новости, личная жизнь",
      snippet:
        "23 июл. 2026 г. — Фёдор Сергеевич Бондарчук. Родился 9 мая 1967 года в Москве. Советский и " +
        "российский актёр, режиссёр, кино- и теле- продюсер, клипмейкер, ...",
      sourceUrl: "https://stuki-druki.com",
    });
    const ex = resolveExampleQuote(home, BUSINESS, null, {
      subjectNames: SUBJECT_NAMES,
      verdict: {
        tone: "neutral",
        quoted: true,
        subjectMatch: "unclear",
        quotes: ["Биографии знаменитых людей, новости кино и шоу-бизнеса - Штуки-Дрюки"],
      },
    });
    expect(ex?.title).not.toContain("Штуки-Дрюки");
    expect(ex?.title).toContain("Федор Бондарчук - биография");
  });

  it("Ц10: цитата страницы тоже обязана быть целой фразой: обрывок с «...Read more» и фраза с маленькой буквы не печатаются", () => {
    // Реплей отчёта Бондарчука после первой редакции шага: en.russia.ru дал
    // «…Fyodor...Read more» и «producer, actor, founder and co-founder of Art
    // Pictures Studio Fyodor Bondarchuk.» — оба со словом темы, оба не фразы.
    const FAMILY = getFindingThemes().find((t) => t.themeId === "family_associates")!;
    const expo = item({
      inventoryId: "expo",
      title: "RUSSIA EXPO — creative meeting with Fyodor Bondarchuk",
      snippet: "",
      sourceUrl: "https://en.russia.ru/expo/bondarchuk",
      region: "UAE",
    });
    const fragments = [
      "On Saturday, March 2, the RUSSIA EXPO will host a creative meeting with director, producer, actor, founder and co-founder of Art Pictures Studio Fyodor...Read more",
      "producer, actor, founder and co-founder of Art Pictures Studio Fyodor Bondarchuk.",
    ];
    expect(
      resolveExampleQuote(expo, FAMILY, null, {
        subjectNames: SUBJECT_NAMES,
        verdict: { tone: "neutral", quoted: true, subjectMatch: "subject", quotes: fragments },
      })
    ).toBeNull();
    const whole =
      "The RUSSIA EXPO hosted a creative meeting with Fyodor Bondarchuk, founder and co-founder of Art Pictures Studio.";
    const ex = resolveExampleQuote(expo, FAMILY, null, {
      subjectNames: SUBJECT_NAMES,
      verdict: { tone: "neutral", quoted: true, subjectMatch: "subject", quotes: [...fragments, whole] },
    });
    expect(ex?.title).toBe(whole);
  });

  it("Ц7: предложение сниппета, обрезанное поисковиком, не цитируется", () => {
    const truncated = item({
      inventoryId: "sovcombank",
      title: "Олег Дерипаска — новости и статьи",
      snippet: "Олег Дерипаска — российский предприниматель. На выборах он был единственным ...",
      sourceUrl: "https://journal.sovcombank.ru/persons/deripaska",
    });
    expect(
      resolveExampleQuote(truncated, POLITICAL, null, { subjectNames: ["Дерипаска Олег Владимирович"] })
    ).toBeNull();
  });

  it("отбор примеров темы видит решения по страницам", () => {
    const examples = pickClaimExamples([WIKI], POLITICAL, [WIKI], null, {
      subjectNames: SUBJECT_NAMES,
      verdictByRef: { "inventory:wiki": WIKI_VERDICT },
    });
    expect(examples).toHaveLength(1);
    expect(examples[0]!.title).toContain("Единая Россия");
  });
});

describe("Ц8: оценка принадлежит материалу, цитата — странице", () => {
  it("цитаты едут только на тот же адрес", () => {
    const a = item({
      inventoryId: "a",
      title: "дуров суд сегодня",
      sourceUrl: "yandex-suggest://q1",
      evidenceType: "suggestion",
    });
    const b = item({
      inventoryId: "b",
      title: "дуров суд сегодня",
      sourceUrl: "yandex-suggest://q2",
      evidenceType: "suggestion",
    });
    const spread = spreadVerdictsOverMaterials([a, b], {
      "inventory:a": {
        tone: "adverse",
        quoted: true,
        subjectMatch: "subject",
        quotes: ["Суд назначил заседание по делу на пятницу."],
      },
    });
    expect(spread["inventory:b"]?.tone).toBe("adverse");
    expect(spread["inventory:a"]?.quotes).toEqual(["Суд назначил заседание по делу на пятницу."]);
    expect(spread["inventory:b"]?.quotes ?? []).toEqual([]);
  });
});
