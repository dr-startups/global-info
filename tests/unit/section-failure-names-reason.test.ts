/**
 * Отказ обязательной секции называет причину, а не только имя секции.
 *
 * Заказчик дважды получал `deck assembly failed: required sections failed:
 * EXECUTIVE/EXECUTIVE_SUMMARY:FAILED — build stopped` и ничего больше. Причина
 * при этом была известна проверке секций и лежала в артефакте на диске
 * («bullet over budget on p03_executive: 916>900»), но за ней надо было идти
 * в файлы прогона.
 *
 * Диагноз должен ехать вместе с отказом.
 */

import { describe, expect, it } from "vitest";
import { buildReportSectionManifest } from "../../src/modules/digital-profile/orion-golden/deck-sections/section-manifest";
import type { SectionValidationReport } from "../../src/modules/digital-profile/orion-golden/deck-sections/section-validation";
import type {
  FragmentKey,
  SectionPackV2,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/contracts";

const CASE = "case-1";
const RUN = "run-1";
const DATASET = "dataset-1";

function pack(over: Partial<SectionPackV2> = {}): SectionPackV2 {
  return {
    fragmentKey: "EXECUTIVE_SUMMARY" as FragmentKey,
    caseId: CASE,
    reportRunId: RUN,
    datasetId: DATASET,
    sourceDatasetId: DATASET,
    required: true,
    status: "READY",
    contentHash: "hash-1",
    slides: [],
    metrics: {
      displayedCount: 0,
      datasetCount: 0,
      adverseDisplayedCount: 0,
      adverseDatasetCount: 0,
    },
    inputs: { sourceFindingIds: [], evidenceRefs: [] },
    sourceFindingIds: [],
    evidenceRefs: [],
    ...over,
  } as unknown as SectionPackV2;
}

function manifestFor(report: SectionValidationReport | undefined) {
  const reports = new Map<FragmentKey, SectionValidationReport>();
  if (report) reports.set("EXECUTIVE_SUMMARY" as FragmentKey, report);
  return buildReportSectionManifest({
    caseId: CASE,
    reportRunId: RUN,
    sourceDatasetId: DATASET,
    packs: [pack()],
    validationReports: reports,
  });
}

describe("отказ обязательной секции", () => {
  it("несёт причину рядом с именем секции", () => {
    const m = manifestFor({
      fragmentKey: "EXECUTIVE_SUMMARY" as FragmentKey,
      passed: false,
      issues: ["bullet over budget on p03_executive: 916>900"],
    });
    expect(m.requiredSectionsFailed).toHaveLength(1);
    const line = m.requiredSectionsFailed[0]!;
    expect(line).toContain("EXECUTIVE_SUMMARY:FAILED");
    // Главное: по сообщению видно, что чинить.
    expect(line).toContain("bullet over budget on p03_executive: 916>900");
  });

  it("не превращает сообщение в простыню при множестве претензий", () => {
    const m = manifestFor({
      fragmentKey: "EXECUTIVE_SUMMARY" as FragmentKey,
      passed: false,
      issues: ["первая", "вторая", "третья", "четвёртая"],
    });
    const line = m.requiredSectionsFailed[0]!;
    expect(line).toContain("первая; вторая");
    expect(line).toContain("и ещё 2");
    expect(line).not.toContain("третья");
  });

  it("отсутствие отчёта проверки названо словом, а не пустотой", () => {
    // Секция без отчёта считается непроверенной и тоже блокирует сборку —
    // оператор должен понимать, чем именно она провалилась.
    const m = manifestFor(undefined);
    expect(m.requiredSectionsFailed[0]).toContain("нет отчёта проверки секции");
  });

  it("прошедшая проверку секция сборку не блокирует", () => {
    const m = manifestFor({
      fragmentKey: "EXECUTIVE_SUMMARY" as FragmentKey,
      passed: true,
      issues: [],
    });
    expect(m.requiredSectionsFailed).toEqual([]);
    expect(m.buildBlocked).toBe(false);
  });
});
