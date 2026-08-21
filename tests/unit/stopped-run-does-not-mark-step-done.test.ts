/**
 * Шаг, проснувшийся на остановленном прогоне, сделанным не объявляется.
 *
 * На вопрос «что значит конечная стадия джобы для шага» в модуле отвечают
 * дважды. `outcomeFromJob` — после вызова тика — различает: отмена → `skipped`,
 * `FAILED_TERMINAL` → `failed` с кодом джобы, и только `REPORT_READY`
 * с `COMPLETED_PARTIAL` доходят до `done`. Проверка **до** вызова тика
 * различать перестала: любая стадия из `TERMINAL_STAGES` → `done`.
 *
 * Цена расхождения — не косметика. `completeStep` на `DONE` будит следующий
 * шаг, поэтому один неверный `done` идёт каскадом до конца конвейера; все
 * строки `DONE` дают `deriveJobStage` → `REPORT_READY` при джобе
 * `FAILED_TERMINAL` (`workflow-stage-drift` в логе), а `planResumeFromSteps`
 * отвечает `completed` **навсегда**: восстановление отдаёт
 * `JOB_ALREADY_COMPLETED`, и кнопки «Возобновить» у оператора больше нет.
 * Пункт BT; это и есть дрейф прогона Мордашова 19.08.
 *
 * Платный тик не запускается ни до правки, ни после — ради этого короткое
 * замыкание и заводили. Меняется только вердикт.
 */

import { describe, expect, it, vi } from "vitest";
import { applyStepOutcome, deriveJobStage } from "@/modules/digital-profile/workflow/step-plan";
import { planResumeFromSteps } from "@/modules/digital-profile/workflow/resume-plan";
import type { StepOutcome, WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";

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

const NOW = new Date("2026-08-20T09:00:00.000Z");

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

/** Джоба, остановленная отказом рендерера, — состояние прогона владельца. */
function stoppedJob() {
  return {
    caseId: "case-1",
    stage: "FAILED_TERMINAL",
    status: "FAILED",
    compositeDatasetId: "ds-1",
    baseReportRunId: "base-1",
    lastError: "прогон остановлен: рендерер выбросил содержимое (стр. 11, 29)",
    lastErrorCode: "CONTENT_DROPPED_BY_RENDERER",
    cancelRequested: false,
    warnings: [],
  };
}

async function outcomeFor(name: string, job: unknown): Promise<StepOutcome> {
  const { unifiedStepHandlers } = await import(
    "@/modules/digital-profile/workflow/unified-step-handlers"
  );
  tick.mockClear();
  loadJob.mockResolvedValue(job);
  const def = { COMPOSITE_MERGE: 3, REPORT_PREPARE: 4 } as Record<string, number>;
  return await unifiedStepHandlers()[name]!(step(name, def[name] ?? 4, "PENDING"));
}

describe("шаг на остановленном прогоне", () => {
  it("не объявляется сделанным и несёт причину остановки", async () => {
    const outcome = await outcomeFor("REPORT_PREPARE", stoppedJob());

    expect(tick).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("failed");
    if (outcome.kind !== "failed") throw new Error("недостижимо");
    expect(outcome.retryable).toBe(false);
    expect(outcome.code).toBe("CONTENT_DROPPED_BY_RENDERER");
    expect(outcome.message).toContain("рендерер выбросил содержимое");
  });

  it("готовый отчёт по-прежнему закрывает шаг", async () => {
    // Ради `REPORT_READY` короткое замыкание и существует: шаг, проснувшийся
    // на собранном отчёте, сделан — работы для него нет.
    const outcome = await outcomeFor("REPORT_PREPARE", {
      ...stoppedJob(),
      stage: "REPORT_READY",
      status: "COMPLETED",
      lastError: null,
      lastErrorCode: null,
    });

    expect(tick).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("done");
  });

  it("отменённый прогон шаг пропускает, а не засчитывает", async () => {
    const outcome = await outcomeFor("REPORT_PREPARE", { ...stoppedJob(), stage: "CANCELLED" });

    expect(tick).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("skipped");
  });

  it("кнопка «Возобновить» переживает отказанную пересборку", async () => {
    /*
     * Цепочка целиком, ради которой всё и делается: отказанная пересборка
     * перепоставила два последних шага, воркер их подобрал, джоба всё ещё
     * `FAILED_TERMINAL`.
     */
    const rows = [
      step("BASE_COLLECTION", 1, "DONE"),
      step("ARSENKIN_ENRICHMENT", 2, "DONE"),
      step("COMPOSITE_MERGE", 3, "PENDING"),
      step("REPORT_PREPARE", 4, "PENDING"),
    ];

    const settled = [...rows];
    for (const name of ["COMPOSITE_MERGE", "REPORT_PREPARE"]) {
      const i = settled.findIndex((s) => s.name === name);
      const outcome = await outcomeFor(name, stoppedJob());
      const t = applyStepOutcome(settled[i]!, outcome, NOW);
      settled[i] = {
        ...settled[i]!,
        state: t.state,
        attempts: t.attempts,
        nextRunAt: t.nextRunAt,
        lastError: t.lastError,
        lastErrorCode: t.lastErrorCode,
      };
    }

    // Стадия, выведенная из строк, совпадает со стадией джобы — дрейфа нет.
    expect(deriveJobStage(settled).stage).toBe("FAILED_TERMINAL");

    // И «где мы остановились» отвечает местом остановки, а не «всё готово».
    const plan = planResumeFromSteps(settled, NOW);
    expect(plan.kind).toBe("resume");
    if (plan.kind !== "resume") throw new Error("недостижимо");
    expect(plan.stepName).toBe("COMPOSITE_MERGE");
    expect(plan.requeue).toBe(true);

    // Причина остановки на строке шага сохранена, а не стёрта.
    const merge = settled.find((s) => s.name === "COMPOSITE_MERGE")!;
    expect(merge.lastErrorCode).toBe("CONTENT_DROPPED_BY_RENDERER");
  });
});
