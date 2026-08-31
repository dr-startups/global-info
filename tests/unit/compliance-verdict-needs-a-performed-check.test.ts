/**
 * Вывод о совпадениях делается только по состоявшейся проверке.
 *
 * Прогон 91: единственная работающая база ответила `401 Invalid API key`,
 * проверок не состоялось ни одной — а лист комплаенса начинался словами
 * «Совпадений по субъекту в комплаенс-базах в этом прогоне не зафиксировано».
 * Это утверждение о человеке, сделанное при нуле выполненных проверок: ветка
 * выбиралась по **наличию записи о попытке** (`outcomes.length === 0`), а не по
 * тому, состоялась ли хоть одна.
 *
 * Второе: причина отказа доезжает до клиента **кодом**, и словаря для
 * `PROVIDER_UNAUTHORIZED` не было — 401 печатался как «источник не ответил в
 * этом прогоне». Источник ответил, и ответил понятно.
 */

import { describe, expect, it } from "vitest";
import { buildComplianceFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const METRIC_SNAPSHOT = {
  metricSnapshotId: "m-1",
  datasetId: "d-1",
  reportRunId: "r-1",
  baseCount: 40,
  enrichmentCount: 0,
  compositeCount: 40,
  subjectMatchCount: 5,
  likelySubjectCount: 0,
  ambiguousCount: 0,
  otherSubjectCount: 0,
  adverseFindingCount: 0,
  perRegionCounts: { RU: 40 },
};

function summaryOf(screenings: unknown[]): SlideContentContract {
  const scoped = {
    subject: { displayName: "Умар Кремлев", aliases: [] },
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
  const slides = buildComplianceFragment(
    "COMPLIANCE" as never,
    scoped as never,
    { complianceScreenings: screenings } as never
  ).slides;
  const summary = slides.find((s) => s.templateId === "coverage-empty-state");
  if (!summary) throw new Error("сводного листа комплаенса нет");
  return summary;
}

const REJECTED = {
  provider: "OPEN_SANCTIONS",
  status: "PROVIDER_ERROR",
  hitCount: 0,
  errorCode: "PROVIDER_UNAUTHORIZED",
  finishedAt: "2026-08-31T09:00:00.000Z",
};

const PERFORMED = {
  provider: "DOW_JONES",
  status: "SUCCESS",
  hitCount: 0,
  finishedAt: "2026-08-31T09:00:00.000Z",
  errorCode: null,
};

describe("ноль состоявшихся проверок — ноль выводов о субъекте", () => {
  it("единственная отвергнутая проверка вывода о чистоте не даёт", () => {
    const summary = summaryOf([REJECTED]);
    const narrative = String(summary.content.narrative ?? "");
    expect(narrative).not.toContain("не зафиксировано");
    expect(narrative).toContain("не проверялась");
  });

  it("причина отказа названа словами клиента, а не общим молчанием", () => {
    const bullets = (summaryOf([REJECTED]).content.bullets ?? []).join(" | ");
    expect(bullets).toContain("ключ не принят");
    expect(bullets).not.toContain("источник не ответил в этом прогоне");
  });

  it("одна состоявшаяся проверка вывод возвращает, а отказ называет отдельно", () => {
    const summary = summaryOf([REJECTED, PERFORMED]);
    const narrative = String(summary.content.narrative ?? "");
    const bullets = (summary.content.bullets ?? []).join(" | ");
    expect(narrative).toContain("не зафиксировано");
    expect(bullets).toContain("ключ не принят");
    expect(bullets).toContain("совпадений по субъекту не найдено");
  });

  it("найденные записи, не дошедшие до отчёта, выводом о чистоте не бывают", () => {
    /*
     * `SUCCESS` с `hitCount > 0` — это проверка **с совпадениями**, которых на
     * листе нет. Первое предложение «совпадений не зафиксировано» опровергалось
     * бы вторым — буллетом «найдено записей — 3, но в материал отчёта не вошла
     * ни одна» — на той же странице.
     */
    const summary = summaryOf([{ ...PERFORMED, hitCount: 3 }]);
    const narrative = String(summary.content.narrative ?? "");
    expect(narrative).not.toContain("Совпадений по субъекту");
    expect(narrative).toContain("записи найдены");
    expect((summary.content.bullets ?? []).join(" ")).toContain("не вошла ни одна");
  });

  it("прочие коды отказа тоже переведены, а запасная фраза означает своё", () => {
    const rate = (summaryOf([{ ...REJECTED, errorCode: "PROVIDER_RATE_LIMITED" }]).content.bullets ?? []).join(" ");
    expect(rate).toContain("частот");
    const bad = (summaryOf([{ ...REJECTED, errorCode: "PROVIDER_BAD_RESPONSE" }]).content.bullets ?? []).join(" ");
    expect(bad).toContain("ошибк");
    const timeout = (summaryOf([{ ...REJECTED, errorCode: "PROVIDER_TIMEOUT" }]).content.bullets ?? []).join(" ");
    expect(timeout).toContain("не ответил вовремя");
    /*
     * Запрос, который не отправлялся, «неответом источника» назван быть не
     * может: у субъекта не заполнено имя, и провайдер отказал до сети.
     */
    const noName = (summaryOf([{ ...REJECTED, errorCode: "SUBJECT_NAME_MISSING" }]).content.bullets ?? []).join(" ");
    expect(noName).toContain("запрос не отправлялся");
    expect(noName).not.toContain("источник не ответил");
  });
});
