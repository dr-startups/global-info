import { describe, expect, it } from "vitest";
import { buildFrontMatterFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/front-matter";
import { buildIdentityFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/identity";
import { slotsForFragment } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { DeckTemplateId } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type {
  PersonaDecisionRecord,
  ScopedFragmentInput,
} from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import {
  reflowNarrativeParagraphs,
  type FragmentExtras,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

/**
 * Отчёт называет, кого проверяли, — собственным листом front-matter.
 *
 * Решение оператора о персоне принимается до первой траты и лежит в базе.
 * Читатель отчёта — сам субъект: если в документ попал однофамилец, он пойдёт
 * добиваться удаления чужого материала, то есть потратит деньги и время не на
 * то. Поэтому блок обязан быть **проверяемым** (источник словами и адрес, а не
 * одно имя) и стоять рано, а не тридцать первой страницей из пятидесяти шести.
 *
 * Прежнее место — первый абзац страницы `p13_ru_wikipedia` — молча съедало
 * вывод самой страницы: её абзац в закреплённом золотом эталоне 952 знака при
 * измеренной ёмкости листа ≈998, и блок вытеснял хвост без единой записи о
 * потере. Поэтому у блока свой лист со своей мерянной ёмкостью.
 */

const SCOPED = {
  subject: { displayName: "Умар Кремлёв", aliases: [] },
  findings: [],
  surfaceUnits: [],
  evidenceIndex: {},
  scope: { regions: null, surfaces: null, subjectMatch: null, findingIds: null },
  metricSnapshot: {},
} as unknown as ScopedFragmentInput;

const SANCTIONS_SELECTED: PersonaDecisionRecord = {
  decision: "PERSONA_SELECTED",
  selected: {
    source: "opensanctions",
    title: "Umar Nazarovich Kremlev",
    url: "https://www.opensanctions.org/entities/NK-7fQ2/",
    datesOfBirth: ["1982-06-05"],
  },
  sources: [
    { source: "wikipedia", status: "SUCCESS" },
    { source: "knowledge_graph", status: "SUCCESS" },
    { source: "opensanctions", status: "SUCCESS" },
  ],
  cardCount: 3,
  decidedAt: "2026-08-20T09:00:00.000Z",
};

const WITHOUT_PERSONA: PersonaDecisionRecord = {
  decision: "APPROVED_WITHOUT_PERSONA",
  selected: null,
  sources: [
    { source: "wikipedia", status: "SUCCESS" },
    { source: "knowledge_graph", status: "SUCCESS" },
    { source: "opensanctions", status: "SUCCESS" },
  ],
  cardCount: 3,
  decidedAt: "2026-08-20T09:00:00.000Z",
};

const ALL_SOURCES_FAILED: PersonaDecisionRecord = {
  decision: "APPROVED_WITHOUT_PERSONA",
  selected: null,
  sources: [
    { source: "wikipedia", status: "FAILED" },
    { source: "knowledge_graph", status: "NOT_CONFIGURED" },
    { source: "opensanctions", status: "TIMEOUT" },
  ],
  cardCount: 0,
  decidedAt: "2026-08-20T09:00:00.000Z",
};

/** Лист «Кого проверяли» — третий слайд пакета front-matter. */
function personaSlide(personaDecision: PersonaDecisionRecord | null): SlideContentContract {
  const out = buildFrontMatterFragment(
    "FRONT_MATTER",
    SCOPED,
    { personaDecision: personaDecision ?? undefined } as FragmentExtras
  );
  const slide = out.slides.find((s) => s.baseSlotId === "p03_persona");
  if (!slide) throw new Error(`лист «Кого проверяли» не собран: ${out.slides.map((s) => s.baseSlotId).join(", ")}`);
  return slide;
}

/** Весь клиентский текст листа — то, что прочитает читатель отчёта. */
function sheetText(slide: SlideContentContract): string {
  const c = slide.content;
  return [c.narrative, ...(c.bullets ?? []), c.whatToCheck, c.sourceNote].filter(Boolean).join(" ");
}

describe("лист «Кого проверяли» стоит третьей страницей отчёта", () => {
  it("слот объявлен третьим и рисуется существующей раскладкой рендерера", () => {
    const slots = slotsForFragment("FRONT_MATTER_MAIN");
    const persona = slots.find((s) => s.slotId === "p03_persona");
    expect(persona, "у front-matter должен появиться третий слот").toBeDefined();
    expect(persona!.page).toBe(3);
    expect(persona!.title).toBe("Кого проверяли");
    // Рендерер не трогается: раскладка берётся существующая, значит окна
    // деплоя у работы нет.
    const tpl = DECK_TEMPLATE_REGISTRY[persona!.templateId];
    expect(tpl.rendererTemplate).toBe("orion_golden_no_data_compact");
  });

  it("страницы после третьей сдвинулись на единицу", () => {
    const slots = slotsForFragment("EXECUTIVE_SUMMARY");
    expect(slots.find((s) => s.slotId === "p03_executive")?.page).toBe(4);
  });
});

describe("выбранная персона печатается проверяемо", () => {
  it("источник словами, заголовок карточки и адрес", () => {
    const text = sheetText(personaSlide(SANCTIONS_SELECTED));
    expect(text).toContain("запись OpenSanctions");
    expect(text).toContain("Umar Nazarovich Kremlev");
    expect(text).toContain("opensanctions.org/entities/NK-7fQ2");
  });

  it("процент совпадения карточки клиенту не печатается", () => {
    const text = sheetText(personaSlide(SANCTIONS_SELECTED));
    expect(text).not.toMatch(/%/u);
  });

  it("печатается структурная дата рождения записи", () => {
    expect(sheetText(personaSlide(SANCTIONS_SELECTED))).toMatch(
      /дата рождения записи[^.]*1982-06-05/u
    );
  });

  it("карточка без структурной даты рождения даты не выдумывает", () => {
    const text = sheetText(
      personaSlide({
        ...SANCTIONS_SELECTED,
        selected: {
          source: "wikipedia",
          title: "Кремлёв, Умар Назарович",
          url: "https://ru.wikipedia.org/wiki/Кремлёв,_Умар_Назарович",
          datesOfBirth: [],
        },
      })
    );
    expect(text).toContain("статья Википедии");
    expect(text).not.toMatch(/дата рождения/iu);
  });

  it("карточка без адреса говорит об этом словами, а не молчит", () => {
    const text = sheetText(
      personaSlide({
        ...SANCTIONS_SELECTED,
        selected: { source: "knowledge_graph", title: "Умар Кремлёв", url: null, datesOfBirth: [] },
      })
    );
    expect(text).toContain("панель знаний Google");
    expect(text).toMatch(/адрес[^.]*не да|по ссылке нельзя/iu);
  });
});

describe("решение «различимой персоны нет» печатается словами", () => {
  it("фраза и оговорка о принадлежности материалов напечатаны", () => {
    const text = sheetText(personaSlide(WITHOUT_PERSONA));
    expect(text).toContain("различимой персоны нет");
    expect(text).toMatch(/однофамильц/iu);
  });

  it("панель с карточками и панель с отказавшими источниками читаются по-разному", () => {
    const withCards = sheetText(personaSlide(WITHOUT_PERSONA));
    const withoutCards = sheetText(personaSlide(ALL_SOURCES_FAILED));
    expect(withCards).not.toBe(withoutCards);
    expect(withCards).toMatch(/панель показала 3 карточки/u);
    expect(withoutCards).toMatch(/панель не показала ни одной карточки/u);
  });

  it("состояние каждого источника названо словами, а не кодом", () => {
    const text = sheetText(personaSlide(ALL_SOURCES_FAILED));
    expect(text).toContain("Википедия — источник не ответил");
    expect(text).toContain("панель знаний Google — доступ не настроен");
    expect(text).toContain("OpenSanctions — ответ не получен в отведённое время");
    expect(text).not.toMatch(/NOT_CONFIGURED|TIMEOUT|FAILED/u);
  });
});

describe("лист остаётся честным и когда решения нет", () => {
  it("говорит словами, что персону не выбирали", () => {
    const text = sheetText(personaSlide(null));
    expect(text).toMatch(/решени[ея][^.]*не принима|персону не выбирал/iu);
    // Молчание здесь опаснее всего: читатель обязан знать, что принадлежность
    // материалов внешним источником никто не подтверждал.
    expect(text).toMatch(/однофамильц/iu);
  });

  it("ни одна карточка листа не остаётся пустой", () => {
    for (const record of [SANCTIONS_SELECTED, WITHOUT_PERSONA, ALL_SOURCES_FAILED, null]) {
      const slide = personaSlide(record);
      expect(String(slide.content.narrative ?? "").trim().length).toBeGreaterThan(0);
      expect((slide.content.bullets ?? []).filter((b) => b.trim()).length).toBeGreaterThan(0);
      expect(String(slide.content.whatToCheck ?? "").trim().length).toBeGreaterThan(0);
    }
  });
});

describe("абзац листа влезает на лист", () => {
  /**
   * Худший законный вход: решения без персоны, двенадцать показанных карточек
   * и все три источника в `OFFLINE` — самая длинная фраза состояния.
   * Проверка держит именно его, а не типичный случай.
   */
  const WORST: PersonaDecisionRecord = {
    decision: "APPROVED_WITHOUT_PERSONA",
    selected: null,
    sources: [
      { source: "wikipedia", status: "OFFLINE" },
      { source: "knowledge_graph", status: "OFFLINE" },
      { source: "opensanctions", status: "OFFLINE" },
    ],
    cardCount: 12,
    decidedAt: "2026-08-20T09:00:00.000Z",
  };

  it("худший законный вход укладывается в бюджет листа с запасом", () => {
    const slide = personaSlide(WORST);
    const budget = DECK_TEMPLATE_REGISTRY[slide.templateId as DeckTemplateId].layout.narrativeCharBudget;
    const length = String(slide.content.narrative ?? "").length;
    expect(length).toBeGreaterThan(0);
    expect(length, `абзац ${length} против бюджета ${budget}`).toBeLessThanOrEqual(budget);
    // Запас, а не впритык: 27 знаков запаса на прежнем месте и были дефектом.
    expect(length).toBeLessThan(budget * 0.75);
  });

  it("бюджет листа объявлен по замеру рендерера, а не на глаз", () => {
    // Телеметрия разметки эталона, запись `orion_text_body_p49`
    // (`orion_golden_no_data_compact`): 104 знака в одной строке, 10,7 строки
    // помещается → ≈1113 знаков. Бюджет не вправе быть больше замера.
    const tpl = DECK_TEMPLATE_REGISTRY[slotsForFragment("FRONT_MATTER_MAIN")[2]!.templateId];
    expect(tpl.layout.narrativeCharBudget).toBeLessThanOrEqual(1113);
    expect(tpl.layout.narrativeCharBudget).toBeGreaterThanOrEqual(600);
  });
});

describe("страница идентичности блоком больше не трогается", () => {
  it("построитель Википедии о персоне не знает и абзац её не несёт", () => {
    const scoped = {
      subject: { displayName: "Умар Кремлёв", aliases: [] },
      findings: [],
      surfaceUnits: [
        {
          surface: "wikipedia",
          region: "RU",
          claims: [],
          metrics: [
            { key: "totalCount", value: 1, sampleStatus: "MEASURED", denominator: 1 },
            { key: "subjectMatchCount", value: 1, sampleStatus: "MEASURED" },
            { key: "otherSubjectCount", value: 0, sampleStatus: "MEASURED" },
            { key: "ambiguousCount", value: 0, sampleStatus: "MEASURED" },
            { key: "adverseSubjectCount", value: 0, sampleStatus: "MEASURED", denominator: 0 },
          ],
          evidenceRefs: ["inventory:wiki-row-0"],
          emptyMarkerRefs: [],
        },
      ],
      evidenceIndex: {
        "inventory:wiki-row-0": {
          kind: "wikipedia",
          region: "RU",
          title: "Умар Кремлёв — биография",
          domain: "ru.wikipedia.org",
          url: "https://ru.wikipedia.org/wiki/row0",
          subjectDecision: "SUBJECT_MATCH",
        },
      },
      scope: { regions: ["RU"], surfaces: ["wikipedia"], subjectMatch: null, findingIds: null },
      metricSnapshot: {},
    } as unknown as ScopedFragmentInput;
    // Четыре аргумента: пятого (extras) у построителя больше нет — блок уехал
    // на свой лист, и абзац страницы Википедии снова принадлежит ей одной.
    const [slide] = buildIdentityFragment(
      "RU_IDENTITY_WIKIPEDIA",
      "RU_PROFILE",
      "Россия",
      scoped
    ).slides;
    expect(String(slide!.content.narrative ?? "")).not.toMatch(/Кого проверяли|различимой персоны/u);
  });
});

/*
 * Сноску на листе рендерер склеивает сам: `methodologyNote` шаблона плюс
 * `sourceNote` слайда. Повторять эту склейку в проверке нельзя — получился бы
 * второй ответ на вопрос «как выглядит сноска», и он расходился бы с первым
 * молча. Поэтому оба слагаемых проверяются по отдельности: постоянное — один
 * раз, состояние — по состояниям.
 */
describe("сноска листа верна во всех четырёх состояниях", () => {
  it("постоянная часть сноски адреса не обещает вовсе", () => {
    // Обещание «карточку можно открыть по указанному адресу» стояло именно
    // здесь и печаталось на всех состояниях. На трёх из четырёх ни карточки, ни
    // адреса не существует, и лист прямо над сноской говорит об этом: читатель
    // ищет адрес, не находит и не понимает, чему верить.
    const method =
      DECK_TEMPLATE_REGISTRY[
        slotsForFragment("FRONT_MATTER_MAIN")[2]!.templateId
      ].methodologyNote ?? "";
    expect(method.length).toBeGreaterThan(40);
    expect(method).not.toMatch(/адрес/iu);
  });

  it("часть про адрес печатается только там, где адрес есть", () => {
    expect(personaSlide(SANCTIONS_SELECTED).content.sourceNote).toMatch(/по указанному адресу/u);
    const noAddress: PersonaDecisionRecord = {
      ...SANCTIONS_SELECTED,
      selected: { source: "knowledge_graph", title: "Умар Кремлёв", url: null, datesOfBirth: [] },
    };
    for (const record of [noAddress, WITHOUT_PERSONA, ALL_SOURCES_FAILED, null]) {
      expect(
        personaSlide(record).content.sourceNote,
        `состояние: ${record?.decision ?? "решения нет"}`
      ).toBeUndefined();
    }
  });
});

describe("совет листа не возвращается к формулировкам, которые уже убрали", () => {
  /*
   * Это **регрессионный сторож, а не проверка правила**: «указание, адресованное
   * нам» словарём не выражается, и текст вроде «запросить у аналитика повторный
   * запуск панели» он пропустит. Держит он ровно те семьи формулировок, которые
   * из листа уже убирали, — и на этом его обещание кончается. Настоящую
   * проверку регистра делает человек, читая лист во всех состояниях.
   */
  const OUR_WORK =
    /собрать панель|собери панель|принять решение до|запросить у|обратиться к оператору|направить запрос|запустить панель|повторный запуск/iu;

  it("ни одно состояние не поручает читателю нашу работу теми словами", () => {
    for (const record of [SANCTIONS_SELECTED, WITHOUT_PERSONA, ALL_SOURCES_FAILED, null]) {
      const advice = String(personaSlide(record).content.whatToCheck ?? "");
      expect(advice, `состояние: ${record?.decision ?? "решения нет"}`).not.toMatch(OUR_WORK);
      expect(advice.length).toBeGreaterThan(40);
    }
  });
});

describe("напечатанный абзац листа равен отданному — резак ничего не выбрасывает", () => {
  /*
   * Между построителем и рендерером стоит `reflowNarrativeParagraphs`: он делит
   * абзац по предложениям с пределом `max(180, длина/3)` и **молча выбрасывает**
   * всё, что не влезло, — и четвёртое предложение целиком, и хвост предложения
   * длиннее предела. Ни записи, ни события, ни `droppedLines`.
   *
   * Поэтому мерить то, что отдал построитель, бессмысленно: на худшем законном
   * входе он отдаёт 403 знака, а до листа доезжает 344, и «OpenSanctions — …»
   * исчезает целиком. Мерить надо ту величину, которая печатается.
   */
  const compact = (value: string): string => value.replace(/\s+/gu, "");

  /** Абзац в том виде, в каком его получит рендерер. */
  function printed(record: PersonaDecisionRecord | null): string {
    return reflowNarrativeParagraphs(String(personaSlide(record).content.narrative ?? ""));
  }

  const WORST: PersonaDecisionRecord = {
    decision: "APPROVED_WITHOUT_PERSONA",
    selected: null,
    sources: [
      { source: "wikipedia", status: "OFFLINE" },
      { source: "knowledge_graph", status: "OFFLINE" },
      { source: "opensanctions", status: "OFFLINE" },
    ],
    cardCount: 12,
    decidedAt: "2026-08-20T09:00:00.000Z",
  };

  const THREE_DATES: PersonaDecisionRecord = {
    decision: "PERSONA_SELECTED",
    selected: {
      source: "opensanctions",
      title: "Umar Nazarovich Kremlev",
      url: "https://www.opensanctions.org/entities/NK-7fQ2/",
      datesOfBirth: ["1982-06-05", "1982-06-06", "1983-01-01"],
    },
    sources: [{ source: "opensanctions", status: "SUCCESS" }],
    cardCount: 3,
    decidedAt: "2026-08-20T09:00:00.000Z",
  };

  it.each([
    ["худший законный вход", WORST],
    ["запись с тремя датами рождения", THREE_DATES],
    ["решения нет", null],
  ])("%s: до листа доезжает весь абзац", (_what, record) => {
    const source = String(personaSlide(record).content.narrative ?? "");
    expect(compact(printed(record))).toBe(compact(source));
  });

  it("третий источник не пропадает из перечисления состояний", () => {
    // Признак 4.2: лист называет состояние источников на момент решения. Список
    // из двух вместо трёх — неполный ответ, и читателю не видно, что он неполон.
    expect(printed(WORST)).toContain("OpenSanctions");
  });

  it("список дат рождения не обрывается посреди перечисления", () => {
    const text = printed(THREE_DATES);
    expect(text).toContain("1983-01-01");
    expect(text).toContain("Отчёт целиком собран по этой персоне.");
  });
});
