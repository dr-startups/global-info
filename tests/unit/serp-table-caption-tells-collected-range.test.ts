/**
 * Неполная таблица выдачи подписывается честно, а полная называет свой запрос.
 *
 * Позиции, не записанные при сборе, вернуть нечем: дыры 1, 2, 3, 5 в таблице
 * «Россия — Google» прогона 76 — это строки, которых нет в данных. Молча
 * напечатать их под заголовком «ТОП-20» значит выдать потерю сбора за пустое
 * место в выдаче; поэтому заголовок называет фактический диапазон, а строка
 * под таблицей — причину пропусков.
 *
 * Запрос печатается на странице всегда: читатель должен видеть, чью выдачу он
 * смотрит, — иначе противоречие со снимком соседней страницы необъяснимо.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_TABLE_TOP_N,
  buildSerpFragment,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import { composeFindingProse } from "@/modules/digital-profile/orion-golden/deck-sections/page-narrative";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const QUERY = "Рашников Виктор Филиппович";

/**
 * Оговорка о выборе запроса: наблюдения этих фикстур пометки «это само имя» не
 * несут, то есть запрос выбрали мы. Она печатается сразу за названием запроса
 * и до всего остального — потому что относится к нему.
 */
const CHOSEN_BY_US =
  "Запрос для этой таблицы выбран нами: в собранных данных не отмечено, какой из запросов основной.";

function scopedWithRanks(ranks: number[], engine: "GOOGLE" | "YANDEX" = "GOOGLE"): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  for (const rank of ranks) {
    evidenceIndex[`i${rank}`] = {
      title: `Материал ${rank}`,
      url: `https://example.ru/${rank}`,
      domain: "example.ru",
      region: "RU",
      engine,
      rank,
      rankSource: engine === "GOOGLE" ? "serper" : "yandex",
      query: QUERY,
      queryPurpose: "subject_lookup",
      subjectDecision: "SUBJECT_MATCH",
    };
  }
  return {
    findings: [],
    surfaceUnits: [
      {
        surface: "organic",
        region: "RU",
        claims: [],
        metrics: [],
        evidenceRefs: ranks.map((r) => `i${r}`),
      },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function slidesOf(ranks: number[]) {
  return buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scopedWithRanks(ranks)).slides;
}

/** Полная двадцатка: подписи о потерях на такой таблице нет. */
const FULL_TABLE = Array.from({ length: SERP_TABLE_TOP_N }, (_, i) => i + 1);

/**
 * Полная таблица плюс материал, найденный другим запросом прогона.
 *
 * В таблицу он не попадает — она показывает выдачу по одному запросу, — но в
 * набор проверенных запросов входит: ровно так выглядит живой прогон, где
 * запросов пять.
 */
function scopedWithSeveralQueries(): ScopedFragmentInput {
  const scoped = scopedWithRanks(FULL_TABLE);
  (scoped.evidenceIndex as Record<string, unknown>)["i-other-query"] = {
    title: "Материал другого запроса",
    url: "https://other.ru/1",
    domain: "other.ru",
    region: "RU",
    engine: "GOOGLE",
    rank: 3,
    rankSource: "serper",
    query: "рашников виктор состояние",
    queryPurpose: "subject_lookup",
    subjectDecision: "SUBJECT_MATCH",
  };
  (scoped.surfaceUnits[0] as { evidenceRefs: string[] }).evidenceRefs.push("i-other-query");
  return scoped;
}

/**
 * Абзац страницы в том порядке, в каком его увидит читатель.
 *
 * Счётчика предложений в шаблоне больше нет — над таблицей печатается весь
 * абзац, помещающийся в объявленный потолок, — поэтому проверяется **порядок**
 * предложений, а не «какие два доедут». Склейка `composeFindingProse` в
 * порядок входит: она приписывает к абзацу текст находки.
 */
function pageSentences(slide: SlideContentContract): string[] {
  const content = slide.content;
  const payload = [
    content.narrative,
    composeFindingProse({
      whatWasFound: content.whatWasFound,
      whyItMatters: content.whyItMatters,
      whatToCheck: content.whatToCheck,
      narrative: content.narrative,
      bullets: content.bullets,
      tableCells: content.table?.rows.flat(),
    }),
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n");
  return payload
    .split(/(?<=[.!?…])\s+|\n+/u)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Сколько листов займут N строк — по ёмкости из реестра, а не числом здесь. */
function pageSuffix(rowCount: number): string {
  const cap = DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide;
  const pages = Math.ceil(rowCount / cap);
  return pages > 1 ? ` (1/${pages})` : "";
}

describe("заголовок таблицы называет собранный диапазон", () => {
  it("полная двадцатка подписана как ТОП-20", () => {
    const ranks = Array.from({ length: SERP_TABLE_TOP_N }, (_, i) => i + 1);
    expect(slidesOf(ranks)[0]!.title).toBe(
      `Россия — Google, ТОП-20${pageSuffix(SERP_TABLE_TOP_N)}`
    );
  });

  it("десять собранных позиций подписаны диапазоном", () => {
    const titles = slidesOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).map((s) => s.title);
    expect(titles[0]).toBe(`Россия — Google, позиции 1–10 из ТОП-20${pageSuffix(10)}`);
  });

  it("диапазон считается по напечатанным номерам, а не по их числу", () => {
    // Россия прогона 76: собраны 4, 6, 7, 8, 9, 10 — дыры 1, 2, 3, 5.
    expect(slidesOf([4, 6, 7, 8, 9, 10])[0]!.title).toBe(
      `Россия — Google, позиции 4–10 из ТОП-20${pageSuffix(6)}`
    );
  });
});

describe("строка под таблицей объясняет пропуск номера", () => {
  it("набор без второго чтения называет измеренную глубину", () => {
    /*
     * Прежде здесь стоял перечень «отсутствующих» номеров и обвинение сбора.
     * На прогоне 91 оно было неправдой: собственный API Яндекса возвращает 16
     * строк и двадцати не обещал, а позиции 18–20 лежали в бандле — их не
     * показала дека. Клиенту теперь называют то, что видно в данных: глубину
     * источника; о потере, допущенной декой, говорит ворот приёмки.
     */
    /*
     * Корпус этой проверки снят до проводки второго чтения: `ranksByProvider`
     * у него нет ни у одной строки, значит причину пропуска назвать нечем.
     * Такой набор говорит только измеренное — сколько позиций вернул поисковик.
     */
    const narrative = String(slidesOf([4, 6, 7, 8, 9, 10])[0]!.content.narrative ?? "");
    expect(narrative).toContain("Поисковик вернул по этому запросу 6 позиций из 20");
    expect(narrative).not.toContain("занята материалом");
    expect(narrative).not.toContain("не вернул ни один источник");
    expect(narrative).not.toContain("потеряны при сборе");
  });

  it("у полной таблицы такой строки нет", () => {
    const ranks = Array.from({ length: SERP_TABLE_TOP_N }, (_, i) => i + 1);
    const narrative = String(slidesOf(ranks)[0]!.content.narrative ?? "");
    expect(narrative).not.toContain("Поисковик вернул по этому запросу");
    expect(narrative).not.toContain("потеряны при сборе");
  });
});

describe("страница называет запрос своей таблицы", () => {
  it("печатает его первым предложением", () => {
    const narrative = String(slidesOf([1, 2, 3])[0]!.content.narrative ?? "");
    expect(narrative.startsWith(`Показана выдача Google по запросу «${QUERY}».`)).toBe(true);
  });

  it("называет поисковик в родительном падеже", () => {
    // «Показана выдача Яндекс» — не по-русски, а текст читает клиент.
    const slide = buildSerpFragment(
      "RU_SERP",
      "RU_PROFILE",
      "Россия",
      scopedWithRanks([1, 2, 3], "YANDEX")
    ).slides[0]!;
    expect(String(slide.content.narrative ?? "")).toContain(
      `Показана выдача Яндекса по запросу «${QUERY}».`
    );
  });

  it("не повторяет тот же запрос второй строкой", () => {
    /*
     * Запрос в прогоне один — перечень дословно повторяет строку выше
     * («Показана выдача Google по запросу «X». Выдача проверена по 1 запросу:
     * «X».») и съедает второе печатное предложение, в котором стоит вывод
     * страницы. Повтор с листа уходит, вывод остаётся.
     */
    const slide = slidesOf(FULL_TABLE)[0]!;
    expect(String(slide.content.narrative ?? "")).not.toContain("Выдача проверена по");
    const printed = pageSentences(slide);
    expect(printed[0]).toBe(`Показана выдача Google по запросу «${QUERY}».`);
    // Второе предложение — чей это выбор запроса, третье — оговорка про
    // нумерацию (она печатается всегда), четвёртое — вывод страницы. Повтор
    // запроса не появляется ни в одном из них.
    expect(printed[1]).toBe(CHOSEN_BY_US);
    expect(printed[2]).toBe(
      "Позиции — как их вернул поисковик; спецблоки (картинки, видео, новости) в нумерацию не входят."
    );
    expect(printed[3]).toBe(String(slide.content.whatWasFound ?? "").split(/(?<=[.!?…])\s+/u)[0]);
  });

  it("справки о наборе запросов на странице одного запроса нет вовсе", () => {
    /*
     * Справка уехала на лист «найдено по дополнительным запросам»: там у
     * таблицы есть колонка «Найдено по запросу», и знаменатель объясняет
     * именно её. На странице одного запроса она отвечала на вопрос, которого
     * страница не задавала (решение владельца 31.08.2026).
     */
    const slides = buildSerpFragment(
      "RU_SERP",
      "RU_PROFILE",
      "Россия",
      scopedWithSeveralQueries()
    ).slides;
    const tableA = slides[0]!;
    expect(String(tableA.content.narrative ?? "")).not.toContain("Выдача проверена по");
    const extra = slides.find((s) => s.metrics?.serpExtraQueries === 1);
    expect(String(extra?.content.narrative ?? "")).toContain("Выдача проверена по 2 запросам:");
    const printed = pageSentences(tableA);
    expect(printed[0]).toBe(`Показана выдача Google по запросу «${QUERY}».`);
    // Вывод страницы по-прежнему стоит после оговорки про нумерацию.
    expect(printed[3]).toBe(String(tableA.content.whatWasFound ?? "").split(/(?<=[.!?…])\s+/u)[0]);
  });

  it("на неполной таблице третье предложение — измеренная глубина", () => {
    // Порядок владельца: честность о данных важнее и вывода, и справки.
    const printed = pageSentences(slidesOf([4, 6, 7, 8, 9, 10])[0]!);
    expect(printed[0]).toBe(`Показана выдача Google по запросу «${QUERY}».`);
    expect(printed[1]).toBe(CHOSEN_BY_US);
    expect(printed[2]).toBe(
      "Поисковик вернул по этому запросу 6 позиций из 20; остальных в выдаче на дату сбора не было."
    );
  });

  it("записывает движок и запрос данными — их читают ворота", () => {
    const metrics = slidesOf([1, 2, 3])[0]!.metrics;
    expect(metrics.serpEngine).toBe("GOOGLE");
    expect(metrics.serpQuery).toBe(QUERY);
  });

  it("непозиционная таблица объявляет себя таковой", () => {
    // Ни одной своей позиции: номера строк — порядок сбора, и ворота обязаны
    // это видеть данными, а не догадываться по заголовку.
    const scoped = scopedWithRanks([1, 2]);
    for (const ref of ["i1", "i2"]) {
      const entry = scoped.evidenceIndex[ref] as { rank?: number; rankSource?: string };
      entry.rank = undefined;
      entry.rankSource = undefined;
    }
    const slide = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides[0]!;
    expect(slide.title).toContain("собранная выдача");
    expect(slide.metrics.serpPositional).toBe(0);
  });

  it("позиционная таблица помечена позиционной", () => {
    expect(slidesOf([1, 2, 3])[0]!.metrics.serpPositional).toBe(1);
  });

  it("продолжение таблицы несёт те же движок и запрос", () => {
    const ranks = Array.from({ length: SERP_TABLE_TOP_N }, (_, i) => i + 1);
    const slides = slidesOf(ranks);
    expect(slides.length).toBeGreaterThan(1);
    expect(slides[1]!.metrics.serpEngine).toBe("GOOGLE");
    expect(slides[1]!.metrics.serpQuery).toBe(QUERY);
  });
});
