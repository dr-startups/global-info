/**
 * В колонке «Совпадение по имени» стоит имя самой записи — или прочерк.
 *
 * Колонка заведена решением владельца, чтобы читатель увидел на стр. 68
 * **чужое** имя первой же строкой. Но имя записи и имя субъекта — разные
 * наблюдения, а `pickComplianceClientMatchTitle` при пустом `matchedName`
 * подставляет имя субъекта ещё на сборе: в эталоне 72 все три записи получили
 * «Глинка Сергей Михайлович», хотя своего имени у них нет вовсе. Напечатать его
 * в этой ячейке — значит утверждать, что запись найдена по имени субъекта, а
 * наблюдения за этим нет. Пустое состояние честнее выдуманного: прочерк.
 *
 * Отличить подстановку от настоящего имени по строке нельзя (у настоящего
 * совпадения имя записи законно совпадает с именем субъекта), поэтому решение
 * принимается по данным: есть у записи собственное `matchedName` или нет.
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

const SUBJECT = "Умар Назарович Кремлев";

function buildWith(evidenceIndex: Record<string, unknown>): SlideContentContract[] {
  const scoped = {
    subject: { displayName: SUBJECT, aliases: [] },
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

function summaryNameCell(slides: SlideContentContract[], row = 0): string | undefined {
  const summary = slides.find((s) => s.slideId === "p33_compliance_toc");
  return summary?.content.table?.rows[row]?.[2];
}

function cardNameRow(slides: SlideContentContract[]): string | undefined {
  const card = slides.find((s) => s.continuationOf === "p33_compliance_toc");
  return card?.content.table?.rows.find((r) => r[0] === "Совпадение по имени")?.[1];
}

/** Запись прогона 25.08 в том виде, в каком её отдаёт загрузчик деки. */
const record = (extra: Record<string, unknown>) => ({
  kind: "compliance_hit",
  providerLabel: "OPEN_SANCTIONS",
  matchCategory: "SANCTION_LINKED",
  reviewStatus: "PENDING",
  // Заголовок инвентаря: подстановка уже случилась на сборе, и по нему
  // «своё имя» от «имени субъекта» не отличить.
  title: SUBJECT,
  countries: ["ru"],
  summary: "темы: связь с санкционным лицом; источника в записи: 2",
  url: "https://www.opensanctions.org/entities/ru-inn-504309044808/",
  ...extra,
});

describe("имя в строке комплаенса", () => {
  it("печатается собственное имя записи, а не заголовок инвентаря", () => {
    const slides = buildWith({
      "h-1": record({ matchedName: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН" }),
    });
    expect(summaryNameCell(slides)).toBe("КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН");
    expect(cardNameRow(slides)).toBe("КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН");
  });

  it("у записи без собственного имени стоит прочерк, а не имя субъекта", () => {
    const slides = buildWith({ "h-1": record({}) });
    expect(summaryNameCell(slides)).toBe("—");
    expect(cardNameRow(slides)).toBe("—");
    // Имя субъекта не должно просочиться в карточку ни одной ячейкой.
    const card = slides.find((s) => s.continuationOf === "p33_compliance_toc")!;
    expect(JSON.stringify(card.content.table?.rows)).not.toContain(SUBJECT);
  });

  it("настоящее совпадение по имени субъекта не прячется", () => {
    // Запись санкционного перечня о самом субъекте: её имя законно совпадает
    // с именем субъекта, и подменять его прочерком нельзя.
    const slides = buildWith({ "h-1": record({ matchedName: SUBJECT }) });
    expect(summaryNameCell(slides)).toBe(SUBJECT);
  });

  it("нарративный блоб именем не считается", () => {
    const blob = `Additional information about the designated person ${"x".repeat(80)}`;
    const slides = buildWith({ "h-1": record({ matchedName: blob }) });
    expect(summaryNameCell(slides)).toBe("—");
    expect(cardNameRow(slides)).toBe("—");
  });

  it("блок карточки без имени подписан своей базой, а не пустотой", () => {
    const slides = buildWith({
      "h-1": record({}),
      "h-2": record({ matchedName: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН", matchCategory: "SANCTIONS" }),
    });
    // Карточки шестистрочных записей в один лист не влезают и печатаются на
    // соседних (бюджет строк страницы карточек), поэтому подписи собираются
    // со всех листов раздела — вопрос теста в них, а не в разбивке.
    const groups = slides
      .filter((s) => s.continuationOf === "p33_compliance_toc")
      .flatMap((s) => s.content.table?.groups ?? []);
    expect(groups.map((g) => g.queryDisplay)).toEqual([
      "OpenSanctions",
      "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
    ]);
  });
});
