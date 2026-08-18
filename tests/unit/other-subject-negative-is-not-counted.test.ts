/**
 * Негатив о другом лице не работает на профиль субъекта.
 *
 * Стр. 46 живого прогона: «ОАЭ — подсказки поиска: 4 негативные формулировки»,
 * и одна из четырёх — «viktor feliksovich vekselberg ofac», то есть про другого
 * человека. Счёт страницы брал красные рамки панели, не глядя на
 * принадлежность строки, хотя решение subject-resolution ехало рядом.
 *
 * Фикстуры воспроизводят замеренные панели прогона 76: p28 (десять подсказок,
 * четыре негативные формулировки, одна из них — о Вексельберге) и p32 (десять
 * связанных запросов, негативный один — «OFAC sanctions List»).
 */

import { describe, expect, it } from "vitest";
import { buildRelatedQueriesFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/related";
import { buildSuggestionsFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/suggestions";
import {
  composePageRowComposition,
  panelStatusLine,
  type FragmentExtras,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

type Row = {
  text: string;
  decision?: string;
  /** Строка нарисована на панели красной. */
  adverse?: boolean;
  /** Формулировка негативна, но рамку сняла принадлежность (так пишет панель). */
  adverseWording?: boolean;
};

/** Десять подсказок панели p28 живого прогона. */
const UAE_SUGGESTIONS: Row[] = [
  { text: "viktor filippovich rashnikov sanctions", decision: "SUBJECT_MATCH", adverse: true },
  { text: "viktor rashnikov eu sanctions", decision: "SUBJECT_MATCH", adverse: true },
  { text: "viktor rashnikov ofac", decision: "SUBJECT_MATCH", adverse: true },
  {
    text: "viktor feliksovich vekselberg ofac",
    decision: "OTHER_SUBJECT",
    adverse: false,
    adverseWording: true,
  },
  { text: "viktor rashnikov mmk", decision: "SUBJECT_MATCH" },
  { text: "viktor rashnikov net worth", decision: "SUBJECT_MATCH" },
  { text: "viktor rashnikov yacht", decision: "SUBJECT_MATCH" },
  { text: "rashnikov family" },
  { text: "rashnikov magnitogorsk" },
  { text: "rashnikov news" },
];

/** Десять связанных запросов панели p32 живого прогона. */
const UAE_RELATED: Row[] = [
  { text: "OFAC sanctions List", decision: "INSUFFICIENT_IDENTIFIERS", adverse: true },
  { text: "Iouri chliaifchtein net worth", decision: "INSUFFICIENT_IDENTIFIERS" },
  { text: "viktor rashnikov mmk", decision: "SUBJECT_MATCH" },
  { text: "viktor rashnikov biography", decision: "SUBJECT_MATCH" },
  { text: "rashinov", decision: "INSUFFICIENT_IDENTIFIERS" },
];

function scopedSurface(surface: string, rows: Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  rows.forEach((r, i) => {
    evidenceIndex[`inventory:s${i}`] = {
      title: r.text,
      domain: "google.com",
      url: `https://google.com/?q=${i}`,
      region: "UAE",
      subjectDecision: r.decision,
    };
  });
  return {
    findings: [],
    surfaceUnits: [
      {
        surface,
        region: "UAE",
        engine: "GOOGLE",
        claims: [],
        metrics: [],
        evidenceRefs: rows.map((_, i) => `inventory:s${i}`),
      },
    ],
    evidenceIndex,
    scope: {},
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

/** Панель-снимок: строки в том виде, в каком их нарисовал генератор ассета. */
function extrasWithPanel(slotId: string, rows: Row[], staleAdverse?: number): FragmentExtras {
  return {
    visualAssets: {
      [slotId]: [
        {
          assetRef: `${slotId}-panel`,
          kind: "surface_panel",
          hasImage: true,
          visibleItems: rows.map((r, i) => ({
            ref: `inventory:s${i}`,
            title: r.text,
            adverse: i === staleAdverse ? true : r.adverse === true,
            ...(r.adverseWording ? { adverseWording: true } : {}),
          })),
        },
      ],
    },
  } as unknown as FragmentExtras;
}

function suggestionsPage(rows: Row[], staleAdverse?: number) {
  const scoped = scopedSurface("suggestions", rows);
  const extras = extrasWithPanel("p28_uae_suggestions", rows, staleAdverse);
  const { slides } = buildSuggestionsFragment("UAE_SUGGESTIONS", "UAE_PROFILE", "ОАЭ", scoped, extras);
  return slides.find((s) => s.slideId === "p28_uae_suggestions")!;
}

describe("счёт негатива страницы", () => {
  it("подсказка о другом лице не входит в заголовок-вывод", () => {
    const page = suggestionsPage(UAE_SUGGESTIONS);
    expect(page.title).toContain("3 негативные формулировки");
    expect(page.title).not.toContain("4 негативные формулировки");
  });

  it("статус называет счёт и объясняет исключённую строку", () => {
    const status = suggestionsPage(UAE_SUGGESTIONS).content.statusNote ?? "";
    expect(status).toContain("3 подсказки с негативной формулировкой");
    expect(status).toContain(
      "Ещё 1 строка с негативной формулировкой относится к другому лицу и в счёт не входит."
    );
  });

  it("состав панели по-прежнему называет чужие строки", () => {
    const said = suggestionsPage(UAE_SUGGESTIONS).content.whatWasFound ?? "";
    expect(said).toContain("1 — о других лицах");
    expect(said).toContain("С негативной формулировкой — 3.");
  });

  it("заголовок равен числу строк, которые панель нарисовала красными", () => {
    const page = suggestionsPage(UAE_SUGGESTIONS);
    const drawn = UAE_SUGGESTIONS.filter((r) => r.adverse === true).length;
    expect(drawn).toBe(3);
    expect(page.title).toContain(`${drawn} негативные формулировки`);
  });

  it("устаревший ассет с красной рамкой на чужой строке счёт не поднимает", () => {
    // resume `gpt-copy` читает visual-assets-by-slot.json с диска: строка могла
    // приехать со старой разметкой `adverse: true`.
    const page = suggestionsPage(UAE_SUGGESTIONS, 3);
    expect(page.title).toContain("3 негативные формулировки");
  });

  it("метрика страницы считает то же, что заголовок", () => {
    expect(suggestionsPage(UAE_SUGGESTIONS).metrics?.adverseSuggestions).toBe(3);
  });

  it("без чужих строк статус не меняется ни байтом", () => {
    const rows: Row[] = [
      { text: "viktor rashnikov ofac", decision: "SUBJECT_MATCH", adverse: true },
      { text: "viktor rashnikov mmk", decision: "SUBJECT_MATCH" },
    ];
    const page = suggestionsPage(rows);
    expect(page.content.statusNote).toBe(
      "На этой странице 1 подсказка с негативной формулировкой — их видно до перехода к самим материалам, поэтому они формируют первое впечатление."
    );
    expect(page.title).toContain("1 негативная формулировка");
  });

  it("полностью чужой негатив — заголовок «нет», статус называет лицо", () => {
    const rows: Row[] = [
      {
        text: "viktor feliksovich vekselberg ofac",
        decision: "OTHER_SUBJECT",
        adverseWording: true,
      },
      { text: "viktor rashnikov mmk", decision: "SUBJECT_MATCH" },
    ];
    const page = suggestionsPage(rows);
    expect(page.title).toContain("негативных формулировок нет");
    const status = page.content.statusNote ?? "";
    expect(status).toContain("Негативных формулировок о проверяемом лице на этой странице нет.");
    expect(status).toContain("относится к другому лицу и в счёт не входит");
  });
});

describe("строки печатаются с пометкой", () => {
  it("буллет чужой подсказки несёт префикс конвенции claimText", () => {
    const bullets = suggestionsPage(UAE_SUGGESTIONS).content.bullets ?? [];
    expect(bullets).toContain("Относится к другому лицу: viktor feliksovich vekselberg ofac");
    expect(bullets).toHaveLength(10);
  });

  it("буллет чужого связанного запроса — с тем же префиксом", () => {
    const rows: Row[] = [
      { text: "Каков вклад Глинки в музыку?", decision: "OTHER_SUBJECT" },
      { text: "Глинка Сергей Михайлович трансмашхолдинг", decision: "SUBJECT_MATCH" },
    ];
    const scoped = scopedSurface("paa_related", rows);
    const extras = extrasWithPanel("p20_ru_related_1", rows);
    const { slides } = buildRelatedQueriesFragment("RU_RELATED", "RU_PROFILE", "Россия", scoped, extras);
    const page = slides.find((s) => s.slideId === "p20_ru_related_1")!;
    expect(page.content.bullets).toContain("Относится к другому лицу: Каков вклад Глинки в музыку?");
  });

  it("неподтверждённая принадлежность — не чужая: ни исключения, ни префикса", () => {
    const scoped = scopedSurface("paa_related", UAE_RELATED);
    const extras = extrasWithPanel("p32_uae_related", UAE_RELATED);
    const { slides } = buildRelatedQueriesFragment("UAE_RELATED", "UAE_PROFILE", "ОАЭ", scoped, extras);
    const page = slides.find((s) => s.slideId === "p32_uae_related")!;
    expect(page.content.statusNote).toBe(
      "На этой странице 1 запрос с негативной формулировкой."
    );
    expect(page.content.bullets).toContain("Iouri chliaifchtein net worth");
    expect(page.content.whatWasFound).toContain("требуют уточнения принадлежности");
    expect(page.metrics?.adverseQueries).toBe(1);
  });
});

describe("общий предикат счёта", () => {
  it("строка без решения из счёта не выпадает", () => {
    // Чужой признаётся только строка с решением OTHER_SUBJECT: «неизвестно» —
    // не «о другом лице», иначе исчез бы негатив, принадлежность которого
    // просто не разбирали.
    const rows: Row[] = [{ text: "rashnikov ofac probe", adverse: true }];
    const page = suggestionsPage(rows);
    expect(page.title).toContain("1 негативная формулировка");
  });

  it("собранный набор не считает чужую негативную строку", () => {
    const scoped = scopedSurface("suggestions", [
      { text: "viktor rashnikov ofac", decision: "SUBJECT_MATCH", adverse: true },
      { text: "viktor feliksovich vekselberg ofac", decision: "OTHER_SUBJECT", adverse: true },
    ]);
    (scoped.evidenceIndex["inventory:s0"] as { adverse?: boolean }).adverse = true;
    (scoped.evidenceIndex["inventory:s1"] as { adverse?: boolean }).adverse = true;
    const composition = composePageRowComposition(scoped, ["inventory:s0", "inventory:s1"]);
    expect(composition.shown).toBe(2);
    expect(composition.adverseHeadlines).toBe(1);
  });

  it("при нуле исключённых статусная строка не меняется", () => {
    const noun = { nounOne: "подсказка", nounFew: "подсказки", nounMany: "подсказок" };
    expect(panelStatusLine({ shownAdverse: 0, excludedOtherSubject: 0, ...noun })).toBe(
      panelStatusLine({ shownAdverse: 0, ...noun })
    );
    expect(panelStatusLine({ shownAdverse: 2, excludedOtherSubject: 0, ...noun })).toBe(
      panelStatusLine({ shownAdverse: 2, ...noun })
    );
  });
});
