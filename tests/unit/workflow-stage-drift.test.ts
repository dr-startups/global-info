import { describe, expect, it } from "vitest";
import {
  STAGE_DRIFT_WARNING,
  detectStageDrift,
  mergeDriftWarning,
} from "../../src/modules/digital-profile/workflow/stage-reconciliation";
import { UNIFIED_PIPELINE } from "../../src/modules/digital-profile/workflow/step-plan";
import type { WorkflowStepRow } from "../../src/modules/digital-profile/workflow/step-types";

/**
 * Шаг 12.4 плана (docs/rework/12-durable-step-execution.md).
 *
 * Стадия джобы пока хранится, а не выводится: обработчики стадий не
 * переписывались. Значит, расхождение между тем, что джоба говорит о себе, и
 * тем, что следует из шагов, возможно — и именно такие расхождения дали
 * дефекты 08.0-bis и 11.1. До сих пор они обнаруживались только на живом
 * платном прогоне.
 */

function pipeline(over: Record<string, Partial<WorkflowStepRow>> = {}): WorkflowStepRow[] {
  return UNIFIED_PIPELINE.map((d) => ({
    id: `s-${d.name}`,
    caseId: "c",
    jobId: "j",
    name: d.name,
    position: d.position,
    state: "PENDING",
    attempts: 0,
    maxAttempts: d.maxAttempts ?? 40,
    nextRunAt: null,
    leaseOwner: null,
    leaseUntil: null,
    inputHash: null,
    outputRef: null,
    lastError: null,
    lastErrorCode: null,
    ...(over[d.name] ?? {}),
  })) as WorkflowStepRow[];
}

describe("детектор расхождения стадии", () => {
  it("согласие не поднимает тревогу", () => {
    expect(detectStageDrift("BASE_COLLECTION", pipeline())).toBeNull();
  });

  it("расхождение называет обе стороны", () => {
    // Джоба считает, что собирает базу, а базовый шаг уже закрыт.
    const drift = detectStageDrift("BASE_COLLECTION", pipeline({ BASE_COLLECTION: { state: "DONE" } }));
    expect(drift).toMatchObject({ storedStage: "BASE_COLLECTION", derivedStage: "ARSENKIN_ENRICHMENT" });
    expect(drift!.warning).toBe(`${STAGE_DRIFT_WARNING}:BASE_COLLECTION!=ARSENKIN_ENRICHMENT`);
  });

  it("внутренняя стадия подготовки отчёта расхождением не считается", () => {
    // CLIENT_CONTENT — движение внутри шага REPORT_PREPARE, конвейер такого
    // различия не делает.
    const steps = pipeline({
      BASE_COLLECTION: { state: "DONE" },
      ARSENKIN_ENRICHMENT: { state: "DONE" },
      COMPOSITE_MERGE: { state: "DONE" },
    });
    expect(detectStageDrift("CLIENT_CONTENT", steps)).toBeNull();
  });

  it("частичный результат сверяется через полноту, а не игнорируется", () => {
    // Шаг 12.4b: полнота переехала в отдельное поле, поэтому вывод её больше
    // не затирает и сравнение снова осмысленно.
    const done = pipeline(
      Object.fromEntries(UNIFIED_PIPELINE.map((d) => [d.name, { state: "DONE" as const }]))
    );
    expect(detectStageDrift("COMPLETED_PARTIAL", done, "partial")).toBeNull();
    expect(detectStageDrift("COMPLETED_PARTIAL", done, "full")).toMatchObject({
      derivedStage: "REPORT_READY",
    });
  });

  it("отмена приходит извне конвейера и сравнению не подлежит", () => {
    expect(detectStageDrift("CANCELLED", pipeline())).toBeNull();
  });

  it("без шагов сравнивать не с чем", () => {
    expect(detectStageDrift("BASE_COLLECTION", [])).toBeNull();
    expect(detectStageDrift(null, pipeline())).toBeNull();
  });
});

describe("отметка о расхождении в предупреждениях", () => {
  it("добавляется, когда расхождение есть", () => {
    const drift = detectStageDrift("BASE_COLLECTION", pipeline({ BASE_COLLECTION: { state: "DONE" } }));
    expect(mergeDriftWarning(["другое"], drift)).toEqual(["другое", drift!.warning]);
  });

  it("не накапливается: прежняя отметка заменяется", () => {
    const drift = detectStageDrift("BASE_COLLECTION", pipeline({ BASE_COLLECTION: { state: "DONE" } }));
    const once = mergeDriftWarning([], drift);
    const twice = mergeDriftWarning(once, drift);
    expect(twice).toEqual(once);
  });

  it("снимается, когда расхождение ушло", () => {
    const stale = [`${STAGE_DRIFT_WARNING}:A!=B`, "полезное"];
    expect(mergeDriftWarning(stale, null)).toEqual(["полезное"]);
  });
});
