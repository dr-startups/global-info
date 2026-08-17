/**
 * Страница комплаенс-базы печатает поля записи, а не счётчик со статусом.
 *
 * Эталон отрасли даёт по каждой записи Dow Jones / LexisNexis карточку полей
 * профиля. У нас в `dp_database_profiles` эти поля есть (алиасы, страны, даты
 * рождения, уверенность, сводка, ссылка на карточку), но до слайда доезжали
 * пять из двенадцати: адаптер не клал их в артефакт, загрузчик читал четыре.
 *
 * Здесь закрепляется то, что видит клиент:
 *  · запись с одним именем не рождает «Оценка совпадения: undefined/100»;
 *  · статус проверки — обязательная строка словами, а не мелкое примечание;
 *  · подтверждённое аналитиком совпадение не называется неподтверждённым
 *    (в золотом кейсе оно было «Подтверждено» в таблице и «не подтверждено»
 *    в прозе того же слайда — два ответа на один вопрос на одной странице).
 */

import { describe, expect, it } from "vitest";
import { buildComplianceFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const METRIC_SNAPSHOT = {
  metricSnapshotId: "m-1",
  datasetId: "d-1",
  reportRunId: "r-1",
  baseCount: 100,
  enrichmentCount: 0,
  compositeCount: 100,
  subjectMatchCount: 30,
  likelySubjectCount: 0,
  ambiguousCount: 0,
  otherSubjectCount: 0,
  adverseFindingCount: 1,
  perRegionCounts: { RU: 60, UAE: 40 },
};

function buildWith(evidenceIndex: Record<string, unknown>): SlideContentContract[] {
  const scoped = {
    subject: { displayName: "Йохан Хольмстрём", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "compliance",
        region: "GLOBAL",
        // 90 = 3 записи баз + 87 внутренних находок: метрика поверхности не
        // отвечает на вопрос «сколько записей в базах», и слайд её не цитирует.
        metrics: [{ key: "totalCount", value: 90 }],
        claims: [],
        evidenceRefs: ["c-1"],
      },
    ],
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: null, surfaces: ["compliance"], subjectMatch: null, findingIds: null },
    evidenceIndex,
  };
  return buildComplianceFragment("COMPLIANCE" as never, scoped as never, {} as never).slides;
}

function slideOf(slides: SlideContentContract[], slotId: string): SlideContentContract {
  const found = slides.find((s) => s.slideId === slotId);
  if (!found) throw new Error(`нет слайда ${slotId}`);
  return found;
}

function paramRow(slide: SlideContentContract, key: string): string | undefined {
  return slide.content.table?.rows.find((r) => r[0] === key)?.[1];
}

describe("карточка записи комплаенс-базы", () => {
  it("запись только с именем и базой не рождает мусора в ячейках", () => {
    const dow = slideOf(
      buildWith({
        "hit-1": { kind: "compliance_hit", providerLabel: "DOW_JONES", title: "Хольмстрём Йохан" },
      }),
      "p34_dow_jones"
    );
    const rows = dow.content.table?.rows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(dow.content);
    expect(serialized).not.toMatch(/undefined|NaN/u);
    const keys = rows.map((r) => r[0]);
    // Обязательные три строки: без них таблица не отвечает на вопрос
    // «что это за совпадение и что с ним делать».
    expect(keys).toContain("Совпадение по имени");
    expect(keys).toContain("Категория");
    expect(keys).toContain("Статус проверки");
    // Пустое поле — отсутствующая строка, а не прочерк: прочерк утверждал бы
    // «в записи этого нет», а мы знаем лишь «поле не перенесено».
    expect(keys).not.toContain("Оценка совпадения");
    expect(keys).not.toContain("Сводка записи");
    expect(keys).not.toContain("Страны в записи");
    expect(keys).not.toContain("Карточка записи");
    expect(rows.every((r) => String(r[1] ?? "").trim().length > 0)).toBe(true);
    expect(rows.some((r) => r[1] === "—")).toBe(false);
    expect(paramRow(dow, "Категория")).toBe("Требует ручной классификации");
  });

  it("PENDING виден словами и в сводной таблице, и в карточке", () => {
    const slides = buildWith({
      "hit-1": {
        kind: "compliance_hit",
        providerLabel: "LEXISNEXIS",
        matchCategory: "ADVERSE_MEDIA",
        matchScore: 64,
        reviewStatus: "PENDING",
        title: "Johan Holmstrom",
      },
    });
    expect(slideOf(slides, "p33_compliance_toc").content.table?.rows[0]).toEqual([
      "LexisNexis",
      "Негативные публикации",
      "64/100",
      "Требует ручной проверки",
    ]);
    const lexis = slideOf(slides, "p35_lexis_visual");
    expect(paramRow(lexis, "Статус проверки")).toBe("Требует ручной проверки");
    expect(lexis.content.whatWasFound).toMatch(/не подтверждено и требует ручной проверки/u);
  });

  it("подтверждённое аналитиком совпадение не называется неподтверждённым", () => {
    const slides = buildWith({
      "hit-1": {
        kind: "compliance_hit",
        providerLabel: "LEXISNEXIS",
        matchCategory: "ADVERSE_MEDIA",
        matchScore: 64,
        reviewStatus: "MATCH_CONFIRMED",
        title: "Johan Holmstrom",
      },
    });
    const lexis = slideOf(slides, "p35_lexis_visual");
    expect(paramRow(lexis, "Статус проверки")).toBe("Подтверждено аналитиком");
    expect(lexis.content.whatWasFound).toMatch(/подтверждено аналитиком/iu);
    expect(lexis.content.whatWasFound).not.toMatch(/не подтверждено/u);
    const narrative = slideOf(slides, "p33_compliance_toc").content.narrative ?? "";
    expect(narrative).toMatch(/подтверждено аналитиком — 1/u);
    expect(narrative).not.toMatch(/подтверждённых совпадений нет/u);
  });

  it("поля записи доезжают до карточки полностью", () => {
    const dow = slideOf(
      buildWith({
        "hit-1": {
          kind: "compliance_hit",
          providerLabel: "DOW_JONES",
          matchCategory: "PEP",
          matchScore: 78,
          reviewStatus: "PENDING",
          title: "Хольмстрём Йохан",
          confidence: "HIGH",
          aliases: ["Holmstrom, Johan", "J. Holmström", "Йохан Х.", "Johan H."],
          countries: ["Швеция", "Мальта"],
          datesOfBirth: ["1975-04-02"],
          summary: "Запись политически значимого лица: депутат риксдага 2014–2018.",
          url: "https://example.com/dow-jones/hit-1",
        },
      }),
      "p34_dow_jones"
    );
    expect(paramRow(dow, "Оценка совпадения")).toBe("78/100");
    expect(paramRow(dow, "Уверенность сопоставления")).toBe("высокая");
    expect(paramRow(dow, "Также числится как")).toMatch(/Holmstrom, Johan/u);
    expect(paramRow(dow, "Также числится как")).toMatch(/и ещё 1/u);
    expect(paramRow(dow, "Страны в записи")).toBe("Швеция, Мальта");
    expect(paramRow(dow, "Даты рождения в записи")).toBe("1975-04-02");
    expect(paramRow(dow, "Сводка записи")).toMatch(/депутат риксдага/u);
    expect(paramRow(dow, "Карточка записи")).toBe("https://example.com/dow-jones/hit-1");
    // Связанных лиц (RCA) ни один источник не отдаёт — колонки нет, но запросить
    // их читателю говорим в рекомендации.
    expect(paramRow(dow, "Что сделать")).toMatch(/связанных лиц/u);
  });

  /**
   * Алиасы приходят в форме «Фамилия, Имя» — и Dow Jones, и OpenSanctions
   * отдают их именно так. Склеенные запятой, три имени читаются как шесть.
   */
  it("алиасы разделяются точкой с запятой, а не запятой", () => {
    const dow = slideOf(
      buildWith({
        "hit-1": {
          kind: "compliance_hit",
          providerLabel: "DOW_JONES",
          reviewStatus: "PENDING",
          title: "Хольмстрём Йохан",
          aliases: ["Holmström, Johan", "Johan A. Holmstrom", "Й. Хольмстрём", "Johan H."],
        },
      }),
      "p34_dow_jones"
    );
    expect(paramRow(dow, "Также числится как")).toBe(
      "Holmström, Johan; Johan A. Holmstrom; Й. Хольмстрём и ещё 1"
    );
  });

  /**
   * Страница с двумя записями разного статуса не выносит вердикт по первой:
   * иначе проза скажет «подтверждено аналитиком», а строка второй записи —
   * «Требует ручной проверки». Два ответа на один вопрос на одном листе.
   */
  it("проза страницы описывает состав листа, а не первую запись", () => {
    const record = (i: number, status: string) => ({
      kind: "compliance_hit",
      providerLabel: "LEXISNEXIS",
      matchCategory: "ADVERSE_MEDIA",
      matchScore: 60 + i,
      reviewStatus: status,
      title: `Хольмстрём Йохан ${i}`,
    });
    const lexis = slideOf(
      buildWith({ "h-1": record(1, "MATCH_CONFIRMED"), "h-2": record(2, "PENDING") }),
      "p35_lexis_visual"
    );
    const found = lexis.content.whatWasFound ?? "";
    expect(found).toMatch(/Записей на странице: 2/u);
    expect(found).toMatch(/подтверждено аналитиком — 1/u);
    expect(found).toMatch(/требует ручной проверки — 1/u);
  });

  it("длинная сводка записи обрезается по границе предложения", () => {
    const dow = slideOf(
      buildWith({
        "hit-1": {
          kind: "compliance_hit",
          providerLabel: "DOW_JONES",
          reviewStatus: "PENDING",
          title: "Хольмстрём Йохан",
          summary: `${"Запись содержит сведения о должности и периоде полномочий. ".repeat(12)}`,
        },
      }),
      "p34_dow_jones"
    );
    const summary = paramRow(dow, "Сводка записи") ?? "";
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(300);
  });
});
