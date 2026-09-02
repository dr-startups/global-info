/**
 * Слово стадии не переживает исчерпания бюджета шага.
 *
 * Последняя строка лога владельца — `workflow-stage-drift:FAILED_RETRYABLE!=
 * FAILED_TERMINAL`. Сверка стадии намеренно не трогает расхождения, в которых
 * участвует отказ: их смыслом владеют обработчики стадий. Но здесь речь не о
 * смысле отказа (код и текст не трогаются), а об ответе на другой вопрос —
 * «вернётся ли конвейер сам». Ответ на него лежит в строке шага: срок не
 * назначен и бюджет отказов исчерпан — значит, никто больше не проснётся, и
 * джоба, продолжающая называть себя возобновляемой, обещает то, чего не будет.
 *
 * Модуль чистый: хранилище прогонов и таблица шагов подменены.
 */

import { describe, expect, it, vi } from "vitest";
import type { WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";

const store = vi.hoisted(() => ({
  job: null as Record<string, unknown> | null,
  steps: [] as unknown[],
  patches: [] as Record<string, unknown>[],
}));

vi.mock("@/modules/digital-profile/services/unified-collection-job-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadUnifiedCollectionJob: async () => store.job,
  patchUnifiedCollectionJob: async (_caseId: string, patch: Record<string, unknown>) => {
    store.patches.push(patch);
    store.job = { ...(store.job ?? {}), ...patch };
    return store.job;
  },
}));

vi.mock("@/modules/digital-profile/workflow/step-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPipelineSteps: async () => store.steps,
}));

const NOW = new Date("2026-08-29T10:00:00.000Z");
const DRIFT = "workflow-stage-drift:FAILED_RETRYABLE!=FAILED_TERMINAL";

function prepareStep(over: Partial<WorkflowStepRow>): WorkflowStepRow {
  return {
    id: "s-REPORT_PREPARE",
    caseId: "case-1",
    jobId: "job-1",
    name: "REPORT_PREPARE",
    position: 4,
    state: "FAILED",
    attempts: 10,
    maxAttempts: 10,
    nextRunAt: null,
    leaseOwner: null,
    leaseUntil: null,
    inputHash: null,
    outputRef: null,
    lastError: "narrative over template budget: p13_ru_wikipedia [wikipedia-check] 1013>998",
    lastErrorCode: "ASSEMBLY_QA_FAILED",
    startedAt: null,
    ...over,
  } as WorkflowStepRow;
}

const doneStep = (name: string, position: number): WorkflowStepRow =>
  prepareStep({
    id: `s-${name}`,
    name,
    position,
    state: "DONE",
    attempts: 1,
    lastError: null,
    lastErrorCode: null,
  });

/** Сверка стадии после шага: возвращает джобу, какой она стала. */
async function reconcile(
  prepare: WorkflowStepRow,
  job: Record<string, unknown>
): Promise<{ stage?: string; warnings?: string[] }> {
  store.steps = [
    doneStep("BASE_COLLECTION", 1),
    doneStep("ARSENKIN_ENRICHMENT", 2),
    doneStep("COMPOSITE_MERGE", 3),
    prepare,
  ];
  store.patches = [];
  store.job = { caseId: "case-1", unifiedJobId: "job-1", ...job };
  const { reconcileStageAfterStep } = await import(
    "@/modules/digital-profile/workflow/unified-step-handlers"
  );
  await reconcileStageAfterStep(prepare);
  return store.job as { stage?: string; warnings?: string[] };
}

const failedRetryableJob = {
  stage: "FAILED_RETRYABLE",
  status: "FAILED",
  warnings: ["CANONICAL_PREPARE_BLOCKED"],
};

describe("шаг, который больше не проснётся", () => {
  it("уводит стадию джобы за собой, и предупреждение о расхождении снимается", async () => {
    const job = await reconcile(prepareStep({}), { ...failedRetryableJob, warnings: [DRIFT] });

    expect(job.stage).toBe("FAILED_TERMINAL");
    expect(job.warnings).not.toContain(DRIFT);
  });

  it("невосстановимый отказ — то же самое, бюджет тратить не обязательно", async () => {
    // Признак — назначенный срок, а не остаток попыток: отказ, помеченный
    // невосстановимым, закрывает шаг на первой же попытке (так теперь и
    // останавливается детерминированный гейт подготовки).
    const job = await reconcile(prepareStep({ attempts: 1 }), failedRetryableJob);

    expect(job.stage).toBe("FAILED_TERMINAL");
    expect(job.warnings).not.toContain(DRIFT);
  });

  it("смысл отказа при этом не трогается", async () => {
    const job = await reconcile(prepareStep({}), {
      ...failedRetryableJob,
      lastError: "narrative over template budget: p13_ru_wikipedia",
      lastErrorCode: "ASSEMBLY_QA_FAILED",
    });

    expect((job as { lastErrorCode?: string }).lastErrorCode).toBe("ASSEMBLY_QA_FAILED");
    expect(String((job as { lastError?: string }).lastError)).toContain("narrative over template budget");
  });

  it("панель после этого продолжения не обещает", async () => {
    const { autoResumeState } = await import("@/modules/digital-profile/workflow/auto-resume");
    await reconcile(prepareStep({}), failedRetryableJob);

    expect(autoResumeState(store.steps as WorkflowStepRow[], NOW).pending).toBe(false);
  });
});

describe("прежнее поведение сохранено", () => {
  it("у шага с назначенным повтором стадия не трогается", async () => {
    // Расхождения тут нет вовсе: выведенная стадия — та же `FAILED_RETRYABLE`.
    const job = await reconcile(
      prepareStep({ attempts: 1, nextRunAt: NOW }),
      failedRetryableJob
    );

    expect(job.stage).toBe("FAILED_RETRYABLE");
    expect(job.warnings).not.toContain(DRIFT);
  });

  it("у шага с назначенным сроком стадия не переписывается даже при расхождении", async () => {
    // Признак — назначенный срок, а не слово «FAILED»: шаг, который вернётся
    // сам, стадией не распоряжается, и смысл отказа остаётся за обработчиком.
    const job = await reconcile(prepareStep({ attempts: 1, nextRunAt: NOW }), {
      stage: "ORION_PREPARE",
      status: "WAITING",
      warnings: [],
    });

    expect(job.stage).toBe("ORION_PREPARE");
    expect(job.warnings).toContain("workflow-stage-drift:ORION_PREPARE!=FAILED_RETRYABLE");
  });

  it("расхождение без исчерпанного шага остаётся предупреждением", async () => {
    // Шаг ещё исполняется: место в конвейере под вопросом, и переписывать
    // стадию вслепую нельзя — она принадлежит обработчику.
    const job = await reconcile(prepareStep({ state: "RUNNING", attempts: 1 }), {
      stage: "REPORT_READY",
      status: "COMPLETED",
      warnings: [],
    });

    expect(job.stage).toBe("REPORT_READY");
    expect(job.warnings).toContain("workflow-stage-drift:REPORT_READY!=ORION_PREPARE");
  });
});
