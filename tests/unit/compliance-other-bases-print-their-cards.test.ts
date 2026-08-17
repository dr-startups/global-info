/**
 * Записи баз без собственной страницы печатаются продолжением сводки.
 *
 * Слоты p34/p35 закреплены за Dow Jones и LexisNexis. У единственного живого
 * провайдера (OpenSanctions) своей страницы нет — значит, его поля не
 * печатались бы нигде, и весь перенос полей записи не дошёл бы до отчёта на
 * настоящем прогоне. Карточка того же формата уходит на продолжение p33.
 *
 * Продолжение появляется только у записи, у которой есть хоть одно
 * содержательное поле сверх трёх обязательных: страница ради трёх строк —
 * это лист, который читателю нечего читать (World-Check прогона 72: имя и
 * больше ничего).
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
    subject: { displayName: "Сергей Глинка", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "compliance",
        region: "GLOBAL",
        metrics: [{ key: "totalCount", value: 4 }],
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

const RICH_OPEN_SANCTIONS = {
  kind: "compliance_hit",
  providerLabel: "OPEN_SANCTIONS",
  matchCategory: "SANCTIONS",
  matchScore: 71,
  reviewStatus: "PENDING",
  title: "Глинка Сергей Михайлович",
  aliases: ["Glinka Sergei", "Glinka Sergey"],
  countries: ["Россия"],
  summary: "Запись санкционного перечня: включён в перечень с указанием должности.",
  url: "https://www.opensanctions.org/entities/NK-abc123/",
};

describe("карточки баз без собственной страницы", () => {
  it("запись с полями уходит продолжением сводной страницы", () => {
    const slides = buildWith({ "h-1": RICH_OPEN_SANCTIONS });
    const cont = slides.find((s) => s.continuationOf === "p33_compliance_toc");
    expect(cont, "нет продолжения p33").toBeDefined();
    expect(cont!.isContinuation).toBe(true);
    expect(cont!.baseSlotId).toBe("p33_compliance_toc");
    const keys = (cont!.content.table?.rows ?? []).map((r) => r[0]);
    expect(keys).toContain("Совпадение по имени");
    expect(keys).toContain("Статус проверки");
    expect(keys).toContain("Также числится как");
    expect(keys).toContain("Страны в записи");
    expect(keys).toContain("Сводка записи");
    expect(keys).toContain("Карточка записи");
    // Строка сводной таблицы при этом остаётся: карточка её не заменяет.
    const summary = slides.find((s) => s.slideId === "p33_compliance_toc")!;
    expect(summary.content.table?.rows.map((r) => r[0])).toContain("OpenSanctions");
  });

  it("запись без содержательных полей продолжения не порождает", () => {
    const slides = buildWith({
      "h-1": {
        kind: "compliance_hit",
        providerLabel: "WORLD_CHECK",
        title: "Глинка Сергей Михайлович",
      },
    });
    expect(slides.some((s) => s.continuationOf === "p33_compliance_toc")).toBe(false);
    const summary = slides.find((s) => s.slideId === "p33_compliance_toc")!;
    expect(summary.content.table?.rows.map((r) => r[0])).toContain("World-Check");
  });

  it("страницы Dow Jones и LexisNexis карточками сводки не дублируются", () => {
    const slides = buildWith({
      "h-1": {
        kind: "compliance_hit",
        providerLabel: "DOW_JONES",
        matchCategory: "PEP",
        matchScore: 78,
        reviewStatus: "PENDING",
        title: "Глинка Сергей Михайлович",
        summary: "Запись политически значимого лица.",
      },
    });
    expect(slides.some((s) => s.continuationOf === "p33_compliance_toc")).toBe(false);
  });

  it("больше двух записей одной базы разбиваются на продолжения", () => {
    const record = (i: number) => ({
      kind: "compliance_hit",
      providerLabel: "LEXISNEXIS",
      matchCategory: "ADVERSE_MEDIA",
      matchScore: 60 + i,
      reviewStatus: "PENDING",
      title: `Глинка Сергей ${i}`,
    });
    const slides = buildWith({ "h-1": record(1), "h-2": record(2), "h-3": record(3) });
    const lexisPages = slides.filter(
      (s) => s.baseSlotId === "p35_lexis_visual"
    );
    expect(lexisPages.length).toBe(2);
    expect(lexisPages[1]!.isContinuation).toBe(true);
    expect(lexisPages[1]!.continuationOf).toBe("p35_lexis_visual");
    const names = slides
      .filter((s) => s.baseSlotId === "p35_lexis_visual")
      .flatMap((s) => s.content.table?.rows ?? [])
      .filter((r) => r[0] === "Совпадение по имени")
      .map((r) => r[1]);
    // Ни одна запись не потеряна при разбивке.
    expect(names).toEqual(["Глинка Сергей 1", "Глинка Сергей 2", "Глинка Сергей 3"]);
  });
});
