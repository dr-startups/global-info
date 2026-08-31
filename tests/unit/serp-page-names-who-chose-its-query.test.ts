/**
 * Страница выдачи не выдаёт наш выбор за факт данных.
 *
 * Таблица А обещает «ТОП-20 по запросу ФИО». Пока пометка «это само имя» не
 * доезжала до деки, запрос выбирался запасным правилом — по числу материалов, а
 * при равенстве по алфавиту, — и то же обещание при другом наборе написаний
 * дало бы другую двадцатку. Пометка появилась, но старые наборы её не несут, и
 * запасное правило остаётся живым путём. Тогда страница обязана сказать, что
 * запрос выбран нами: молчание здесь — это выдача нашего решения за данные.
 *
 * Вторая ветка — набор, в котором запроса нет вовсе (`report-72`: 0 наблюдений
 * с запросом из 70 органических). Там таблица не имеет права называться
 * ТОП-20, и её номера — порядок сводки.
 */

import { describe, expect, it } from "vitest";
import { buildSerpFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const QUERY = "Глинка Сергей Михайлович";
const CHOSEN_BY_US =
  "Запрос для этой таблицы выбран нами: в собранных данных не отмечено, какой из запросов основной.";

type Row = { rank?: number; query?: string; marked?: boolean; engine?: string };

function scoped(rows: Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  rows.forEach((row, i) => {
    const ref = `i${i + 1}`;
    evidenceIndex[ref] = {
      title: `Материал ${i + 1}`,
      url: `https://example.ru/${i + 1}`,
      domain: "example.ru",
      region: "RU",
      engine: row.engine ?? "YANDEX",
      ...(row.rank ? { rank: row.rank, rankSource: "yandex" } : {}),
      ...(row.query ? { query: row.query, queryPurpose: "subject_lookup" } : {}),
      ...(row.marked ? { subjectNameQuery: true } : {}),
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

/**
 * Листы первой таблицы выдачи. Вторая («Найдено по дополнительным запросам»)
 * живёт на тех же слайдах-продолжениях и к вопросу «кто выбрал запрос» не
 * относится: она называет запрос у каждой строки своей колонкой.
 */
function pagesOf(rows: Row[]): SlideContentContract[] {
  return buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped(rows)).slides.filter(
    (s) => s.metrics?.serpExtraQueries !== 1
  );
}

function pageText(slide: SlideContentContract): string {
  return `${slide.title ?? ""} ${slide.content.narrative ?? ""}`;
}

describe("страница называет, кто выбрал её запрос", () => {
  it("без пометки в данных оговорка стоит на каждом листе таблицы", () => {
    // Восьми строк хватает на несколько листов при любой ёмкости реестра:
    // оговорка принадлежит таблице, а не первому её листу.
    const rows: Row[] = [1, 2, 3, 4, 5, 6, 7, 8].map((rank) => ({ rank, query: QUERY }));
    const pages = pagesOf(rows);
    for (const page of pages) expect(pageText(page)).toContain(CHOSEN_BY_US);
    expect(pages.length).toBeGreaterThan(1);
  });

  it("с пометкой оговорки нет: запрос назван самими данными", () => {
    const rows: Row[] = [1, 2, 3].map((rank) => ({ rank, query: QUERY, marked: true }));
    for (const page of pagesOf(rows)) expect(pageText(page)).not.toContain("выбран нами");
  });

  it("без запроса оговорки нет: выбирать было не из чего", () => {
    const rows: Row[] = [1, 2, 3].map(() => ({}));
    for (const page of pagesOf(rows)) expect(pageText(page)).not.toContain("выбран нами");
  });
});

describe("набор без запросов даёт честную непозиционную таблицу", () => {
  const pages = pagesOf([{}, {}, {}]);

  it("таблица одна и озаглавлена собранной выдачей", () => {
    expect(pages).toHaveLength(1);
    expect(pages[0]!.title).toContain("собранная выдача");
  });

  it("лид объясняет, что означают номера строк", () => {
    expect(pages[0]!.content.narrative).toContain(
      "Номера строк — порядок в собранной сводке, а не места в выдаче."
    );
  });

  it("слова «ТОП-20» на такой странице нет ни в одной ветке", () => {
    for (const page of pages) expect(pageText(page)).not.toMatch(/ТОП-\d/u);
    expect(pages[0]!.metrics?.serpPositional).toBe(0);
  });

  it("страница называет свой поисковик словами, а не только заголовком", () => {
    /*
     * Тело страницы обязано отличать таблицу Яндекса от таблицы Google.
     * Заголовок их различает, а абзац — нет: без запроса он состоял из одной
     * фразы про номера строк, и два листа разных поисковиков с одинаковой
     * темой печатали дословно один текст (эталон-72: страницы 16 и 22).
     */
    const rows: Row[] = [
      ...[1, 2, 3].map(() => ({ engine: "YANDEX" })),
      ...[1, 2, 3].map(() => ({ engine: "GOOGLE" })),
    ];
    const built = pagesOf(rows);
    expect(built).toHaveLength(2);
    expect(built[0]!.content.narrative).toContain("Яндекса");
    expect(built[1]!.content.narrative).toContain("Google");
    expect(built[0]!.content.narrative).not.toBe(built[1]!.content.narrative);
  });

  it("признак берётся из данных: запрос есть, своей позиции нет — таблица всё равно непозиционная", () => {
    const withQueryNoRank = pagesOf([{ query: QUERY }, { query: QUERY }]);
    expect(withQueryNoRank[0]!.metrics?.serpPositional).toBe(0);
    expect(pageText(withQueryNoRank[0]!)).not.toMatch(/ТОП-\d/u);
  });
});
