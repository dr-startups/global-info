/**
 * Страница базы без записей не утверждает проверку, которой не было.
 *
 * Сегодня слайд печатает одну формулу на все случаи: «Проверка по базе X
 * выполнена: записей о субъекте не зафиксировано». Но выполнения проверки в
 * данных нет: официальный API есть только у OpenSanctions, Dow Jones /
 * LexisNexis / World-Check отвечают `NOT_CONFIGURED` или
 * `PROVIDER_NOT_IMPLEMENTED`, а результат скрининга (`dp_compliance_screening_runs`)
 * до артефактов и деки не доходил вовсе. NOT_CONFIGURED, выданный за
 * «совпадений нет», сообщает банку, что человек проверен, когда он не проверен.
 *
 * Ветвь выбирается данными артефакта: строка рана есть — проверка была
 * (`screenings` из `compliance-inventory.json`), нет строки — не была.
 * Чтения конфигурации из окружения здесь быть не может: клиентский текст стал
 * бы зависеть от машины, на которой собирают отчёт.
 */

import { describe, expect, it } from "vitest";
import { buildComplianceFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const METRIC_SNAPSHOT = {
  metricSnapshotId: "m-1",
  datasetId: "d-1",
  reportRunId: "r-1",
  baseCount: 10,
  enrichmentCount: 0,
  compositeCount: 10,
  subjectMatchCount: 3,
  likelySubjectCount: 0,
  ambiguousCount: 0,
  otherSubjectCount: 0,
  adverseFindingCount: 0,
  perRegionCounts: { RU: 10 },
};

function buildEmpty(extras: Partial<FragmentExtras>): SlideContentContract[] {
  const scoped = {
    subject: { displayName: "Сергей Глинка", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "compliance",
        region: "GLOBAL",
        metrics: [{ key: "totalCount", value: 0 }],
        claims: [],
        evidenceRefs: [],
      },
    ],
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: null, surfaces: ["compliance"], subjectMatch: null, findingIds: null },
    evidenceIndex: {},
  };
  return buildComplianceFragment("COMPLIANCE" as never, scoped as never, extras as never).slides;
}

function dowSlide(slides: SlideContentContract[]): SlideContentContract {
  const found = slides.find((s) => s.slideId === "p34_dow_jones");
  if (!found) throw new Error("нет слайда p34_dow_jones");
  return found;
}

describe("«не настроено» ≠ «совпадений нет»", () => {
  it("успешный скрининг: проверка выполнена, совпадений не найдено", () => {
    const dow = dowSlide(
      buildEmpty({
        complianceScreenings: [
          {
            provider: "DOW_JONES",
            status: "SUCCESS",
            hitCount: 0,
            finishedAt: "2026-05-12T09:30:00.000Z",
          },
        ],
      })
    );
    const narrative = dow.content.narrative ?? "";
    expect(narrative).toMatch(/Проверка по базе Dow Jones выполнена 12\.05\.2026/u);
    expect(narrative).toMatch(/совпадений по субъекту не найдено/u);
    expect(narrative).toMatch(/не вывод об отсутствии рисков/u);
    expect(dow.templateId).toBe("coverage-empty-state");
    expect(dow.emptyStateReason).toBe("no-compliance-records");
  });

  /**
   * Ран нашёл совпадения, а в отчёт не вошло ни одного (сняты разбором или
   * отсеяны как служебные). Сказать «совпадений не найдено» — то же ложное
   * утверждение о проверке, только с другой стороны.
   */
  it("успешный скрининг с находками не выдаётся за «совпадений нет»", () => {
    const dow = dowSlide(
      buildEmpty({
        complianceScreenings: [
          {
            provider: "DOW_JONES",
            status: "SUCCESS",
            hitCount: 3,
            finishedAt: "2026-05-12T09:30:00.000Z",
          },
        ],
      })
    );
    const narrative = dow.content.narrative ?? "";
    expect(narrative).toMatch(/найдено записей — 3/u);
    expect(narrative).not.toMatch(/совпадений по субъекту не найдено/u);
    expect(narrative).toMatch(/в материал отчёта не вошла ни одна/u);
    expect(dow.emptyStateReason).toBe("compliance-records-excluded");
  });

  it("скрининг не удался: проверка не выполнена, причина названа словами", () => {
    const dow = dowSlide(
      buildEmpty({
        complianceScreenings: [
          {
            provider: "DOW_JONES",
            status: "NOT_CONFIGURED",
            hitCount: 0,
            finishedAt: "2026-05-12T09:30:00.000Z",
            errorCode: "PROVIDER_NOT_CONFIGURED",
          },
        ],
      })
    );
    const narrative = dow.content.narrative ?? "";
    expect(narrative).toMatch(/Проверка по базе Dow Jones не выполнена/u);
    expect(narrative).toMatch(/доступ к базе не настроен/u);
    // «Совпадений не найдено» — вывод, которого у неудавшейся проверки нет.
    expect(narrative).not.toMatch(/совпадений по субъекту не найдено/u);
    expect(narrative).not.toMatch(/записей о субъекте не зафиксировано/u);
    expect(narrative).not.toMatch(/PROVIDER_NOT_CONFIGURED/u);
    expect(dow.emptyStateReason).toBe("compliance-check-not-performed");
  });

  it("рана нет: проверка не выполнялась, и рекомендация выполнима", () => {
    const dow = dowSlide(buildEmpty({}));
    const narrative = dow.content.narrative ?? "";
    expect(narrative).toMatch(/не выполнялась/u);
    expect(narrative).toMatch(/доступ подключается по договору/u);
    expect(narrative).not.toMatch(/записей о субъекте не зафиксировано/u);
    expect(dow.content.whatToCheck ?? "").toMatch(/подключить официальный доступ|импортировать/iu);
    expect(dow.content.whatToCheck ?? "").not.toMatch(/Повторить сверку/u);
    expect(dow.emptyStateReason).toBe("compliance-check-not-performed");
  });

  it("все три ветви остаются честным пустым состоянием", () => {
    const branches = [
      buildEmpty({}),
      buildEmpty({
        complianceScreenings: [
          { provider: "DOW_JONES", status: "SUCCESS", hitCount: 0, finishedAt: null },
        ],
      }),
      buildEmpty({
        complianceScreenings: [
          { provider: "DOW_JONES", status: "FAILED", hitCount: 0, finishedAt: null },
        ],
      }),
    ];
    for (const slides of branches) {
      const dow = dowSlide(slides);
      expect(dow.templateId).toBe("coverage-empty-state");
      expect(dow.content.table).toBeUndefined();
      expect(String(dow.emptyStateReason ?? "").length).toBeGreaterThan(0);
      expect(String(dow.content.narrative ?? "").length).toBeGreaterThan(0);
    }
    // Выполненной проверка называется только там, где ран это подтверждает.
    expect(dowSlide(branches[1]!).content.narrative).toMatch(/выполнена: совпадений/u);
    expect(dowSlide(branches[2]!).content.narrative).toMatch(/не выполнена: источник не ответил/u);
  });
});
