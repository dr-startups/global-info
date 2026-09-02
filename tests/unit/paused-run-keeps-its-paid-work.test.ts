/**
 * Пауза прогона не хоронит оплаченную работу.
 *
 * Оркестратор признак отмены honors, хранилище его переживает, но выставить
 * его было некому: во всём коде он только инициализировался `false` и
 * проверялся. Оператор не мог остановить идущий прогон иначе как заплатив за
 * новый сбор — вопрос владельца от 20.08 (пункт CC).
 *
 * Решение владельца 21.08: отмена — это пауза. Приостановленный прогон и
 * возобновляется с места остановки, и позволяет собрать отчёт из уже
 * собранного.
 *
 * Три места, где сегодняшняя отмена хоронила оплаченное: восстановление
 * отказывало (`JOB_CANCELLED`), пересборка отвечала `JOB_NOT_COMPLETED`, а шаг
 * получал `skipped` — и каскад `SKIPPED` до конца конвейера уносил прогон в
 * «всё готово» навсегда.
 *
 * Офлайн: хранилище прогонов файловое, конвейер шагов чистый.
 */

import { describe, expect, it, vi } from "vitest";
import { applyStepOutcome, deriveJobStage } from "@/modules/digital-profile/workflow/step-plan";
import { planResumeFromSteps } from "@/modules/digital-profile/workflow/resume-plan";
import type { WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";

const tick = vi.fn();
const loadJob = vi.fn();

vi.mock("@/modules/digital-profile/services/unified-orion-collection-orchestrator", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runUnifiedCollectionTick: (...args: unknown[]) => tick(...args),
}));

vi.mock("@/modules/digital-profile/services/unified-collection-job-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadUnifiedCollectionJob: (...args: unknown[]) => loadJob(...args),
  patchUnifiedCollectionJob: vi.fn(async () => null),
}));

const NOW = new Date("2026-08-21T09:00:00.000Z");

function step(name: string, position: number, state: WorkflowStepRow["state"]): WorkflowStepRow {
  return {
    id: `s-${name}`,
    caseId: "case-1",
    jobId: "job-1",
    name,
    position,
    state,
    attempts: 0,
    maxAttempts: 40,
    nextRunAt: state === "PENDING" ? NOW : null,
    leaseOwner: null,
    leaseUntil: null,
    inputHash: null,
    outputRef: null,
    lastError: null,
    lastErrorCode: null,
    startedAt: null,
  };
}

function pausedJob() {
  return {
    caseId: "case-1",
    stage: "CANCELLED",
    status: "CANCELLED",
    compositeDatasetId: null,
    baseReportRunId: "base-1",
    lastError: null,
    lastErrorCode: null,
    cancelRequested: true,
    warnings: [],
  };
}

describe("шаг приостановленного прогона", () => {
  it("не запускает платный тик и не считается пропущенным", async () => {
    const { unifiedStepHandlers } = await import(
      "@/modules/digital-profile/workflow/unified-step-handlers"
    );
    tick.mockClear();
    loadJob.mockResolvedValue(pausedJob());
    const outcome = await unifiedStepHandlers()["ARSENKIN_ENRICHMENT"]!(
      step("ARSENKIN_ENRICHMENT", 2, "PENDING")
    );
    expect(tick).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("недостижимо");
    expect(outcome.code).toBe("RUN_PAUSED");
    expect(outcome.retryable).toBe(false);
    expect(outcome.message).toContain("приостановлен");
  });

  it("возобновление остаётся возможным: конвейер не объявляет себя завершённым", async () => {
    const { unifiedStepHandlers } = await import(
      "@/modules/digital-profile/workflow/unified-step-handlers"
    );
    tick.mockClear();
    loadJob.mockResolvedValue(pausedJob());
    const rows = [
      step("BASE_COLLECTION", 1, "DONE"),
      step("ARSENKIN_ENRICHMENT", 2, "PENDING"),
      step("COMPOSITE_MERGE", 3, "PENDING"),
      step("REPORT_PREPARE", 4, "PENDING"),
    ];
    const outcome = await unifiedStepHandlers()["ARSENKIN_ENRICHMENT"]!(rows[1]!);
    const t = applyStepOutcome(rows[1]!, outcome, NOW);
    rows[1] = { ...rows[1]!, state: t.state, attempts: t.attempts, nextRunAt: t.nextRunAt };

    expect(deriveJobStage(rows).stage).not.toBe("REPORT_READY");
    const plan = planResumeFromSteps(rows, NOW);
    expect(plan.kind).toBe("resume");
    if (plan.kind !== "resume") throw new Error("недостижимо");
    expect(plan.stepName).toBe("ARSENKIN_ENRICHMENT");
  });
});
