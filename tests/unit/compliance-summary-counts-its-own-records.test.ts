/**
 * Сводная комплаенс-страница считает по своим записям и пересчитывает статусы.
 *
 * Счётчик «Проверено записей комплаенс-контура: 90» ушёл вместе со своим
 * основанием: 90 — это `totalCount` поверхности, то есть 3 записи баз плюс 87
 * внутренних находок, и фраза «По 89 записям совпадений не выявлено» выдавала
 * внутренние находки за записи комплаенс-баз. Число записей считается по самим
 * записям и совпадает с числом строк таблицы.
 *
 * Нарратив остаётся в двух предложениях, но уже потому, что так читается, а не
 * потому, что третье исчезнет: счётчика предложений в шаблоне больше нет.
 * Рекомендация ручной верификации — отдельное поле `whatToCheck`, и то, что
 * она доезжает до листа, проверяет
 * `renderer/smoke_reading_lines_reach_the_page.py` (Т8г).
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

function summaryOf(evidenceIndex: Record<string, unknown>): SlideContentContract {
  const scoped = {
    subject: { displayName: "Сергей Глинка", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "compliance",
        region: "GLOBAL",
        metrics: [{ key: "totalCount", value: 90 }],
        claims: [],
        evidenceRefs: ["c-1", "c-2"],
      },
    ],
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: null, surfaces: ["compliance"], subjectMatch: null, findingIds: null },
    evidenceIndex,
  };
  const slides = buildComplianceFragment("COMPLIANCE" as never, scoped as never, {} as never).slides;
  const found = slides.find((s) => s.slideId === "p33_compliance_toc");
  if (!found) throw new Error("нет слайда p33_compliance_toc");
  return found;
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

const HIT = (provider: string, name: string, extra: Record<string, unknown> = {}) => ({
  kind: "compliance_hit",
  providerLabel: provider,
  matchCategory: "PEP",
  matchScore: 78,
  reviewStatus: "PENDING",
  title: name,
  ...extra,
});

describe("сводная комплаенс-страница", () => {
  it("остаётся выводом в два предложения во всех ветвях", () => {
    const branches: Record<string, unknown>[] = [
      {},
      { "h-1": HIT("DOW_JONES", "Глинка Сергей Михайлович") },
      {
        "h-1": HIT("DOW_JONES", "Глинка Сергей Михайлович", { reviewStatus: "MATCH_CONFIRMED" }),
        "h-2": HIT("LEXISNEXIS", "Глинка Сергей Михайлович"),
        "h-3": { kind: "compliance_hit", providerLabel: "WORLD_CHECK", title: "Глинка Сергей Михайлович" },
      },
      {
        "h-1": HIT("DOW_JONES", "Глинка Сергей Михайлович"),
        "h-2": HIT("DOW_JONES", "Глинка Сергей Михайлович"),
      },
    ];
    for (const index of branches) {
      const narrative = summaryOf(index).content.narrative ?? "";
      expect(narrative.length).toBeGreaterThan(0);
      expect(sentences(narrative).length, narrative).toBeLessThanOrEqual(2);
    }
  });

  it("число записей считается по записям баз, а не по метрике поверхности", () => {
    const summary = summaryOf({
      "h-1": HIT("DOW_JONES", "Глинка Сергей Михайлович"),
      "h-2": HIT("LEXISNEXIS", "Глинка Сергей Михайлович"),
    });
    const narrative = summary.content.narrative ?? "";
    expect(narrative).toMatch(/Записей о субъекте в комплаенс-базах: 2/u);
    expect(narrative).toMatch(/Dow Jones и LexisNexis/u);
    expect(narrative).not.toMatch(/Проверено записей комплаенс-контура/u);
    expect(narrative).not.toMatch(/По 8[0-9] записям/u);
    expect(summary.content.table?.rows.length).toBe(2);
  });

  it("статусы пересчитываются, а не постулируются", () => {
    const narrative =
      summaryOf({
        "h-1": HIT("DOW_JONES", "Глинка Сергей Михайлович", { reviewStatus: "MATCH_CONFIRMED" }),
        "h-2": HIT("LEXISNEXIS", "Глинка Сергей Михайлович"),
        "h-3": { kind: "compliance_hit", providerLabel: "WORLD_CHECK", title: "Глинка Сергей Михайлович" },
      }).content.narrative ?? "";
    expect(narrative).toMatch(/не подтверждается автоматически/u);
    expect(narrative).toMatch(/подтверждено аналитиком — 1/u);
    expect(narrative).toMatch(/требует ручной проверки — 1/u);
    expect(narrative).toMatch(/статус не зафиксирован — 1/u);
  });

  it("схлопнутые дедупом повторы объяснены словами", () => {
    const summary = summaryOf({
      "h-1": HIT("DOW_JONES", "Глинка Сергей Михайлович"),
      "h-2": HIT("DOW_JONES", "Глинка Сергей Михайлович"),
    });
    expect(summary.content.table?.rows.length).toBe(1);
    expect(summary.content.narrative ?? "").toMatch(/повторные записи объединены: 1/u);
  });

  it("правило ручной верификации стоит отдельным полем страницы", () => {
    // Носитель продуктового правила «совпадение уходит аналитику как PENDING».
    // Пока шаблон печатал два предложения, это поле до листа не доезжало.
    const summary = summaryOf({ "h-1": HIT("DOW_JONES", "Глинка Сергей Михайлович") });
    expect(summary.content.whatToCheck).toBe(
      "Верифицировать каждое потенциальное совпадение вручную: сопоставить идентификаторы субъекта с записью базы."
    );
  });

  it("без записей страница не сочиняет совпадений", () => {
    const narrative = summaryOf({}).content.narrative ?? "";
    expect(narrative).toMatch(/нет|не зафиксировано/u);
    expect(narrative).not.toMatch(/Потенциальных совпадений в базах: 0/u);
  });
});
