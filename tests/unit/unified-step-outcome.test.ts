import { describe, expect, it } from "vitest";
import { outcomeFromJob } from "../../src/modules/digital-profile/workflow/unified-step-handlers";
import type { WorkflowStepRow } from "../../src/modules/digital-profile/workflow/step-types";
import type { UnifiedCollectionJob } from "../../src/modules/digital-profile/services/unified-collection-types";

/**
 * Шаг 12.3 плана.
 *
 * Обработчики стадий не переписывались — переписан тот, кто их вызывает.
 * Значит, весь риск переноса сосредоточен здесь: в чтении того, что стало
 * с джобой после вызова. Ошибка в эту сторону либо застопорит конвейер, либо
 * протолкнёт его вперёд по неполным данным.
 */

const NOW = new Date("2026-07-25T12:00:00.000Z");

const STEP: WorkflowStepRow = {
  id: "s1",
  caseId: "case-1",
  jobId: "job-1",
  name: "ARSENKIN_ENRICHMENT",
  position: 2,
  state: "RUNNING",
  attempts: 0,
  maxAttempts: 40,
  nextRunAt: null,
  leaseOwner: "w",
  leaseUntil: null,
  inputHash: null,
  outputRef: null,
  lastError: null,
  lastErrorCode: null,
};

function job(over: Partial<UnifiedCollectionJob> = {}): UnifiedCollectionJob {
  return {
    caseId: "case-1",
    jobId: "job-1",
    unifiedJobId: "job-1",
    stage: "ARSENKIN_ENRICHMENT",
    status: "WAITING",
    cancelRequested: false,
    warnings: [],
    lastError: null,
    lastErrorCode: null,
    ...over,
  } as UnifiedCollectionJob;
}

describe("исход шага выводится из состояния джобы", () => {
  it("джоба ушла на следующую стадию — шаг сделан", () => {
    const out = outcomeFromJob(STEP, job(), job({ stage: "COMPOSITE_MERGE" }), NOW);
    expect(out.kind).toBe("done");
  });

  it("джоба осталась на своей стадии — шаг ждёт", () => {
    const out = outcomeFromJob(STEP, job(), job({ nextPollAt: new Date(NOW.getTime() + 5_000).toISOString() }), NOW);
    expect(out.kind).toBe("waiting");
    expect(out.kind === "waiting" && out.retryAfterMs).toBe(5_000);
  });

  it("ожидание уважает расписание джобы, а не учащает опрос", () => {
    // Иначе воркер начал бы дёргать провайдера чаще, чем задумано backoff-ом.
    const out = outcomeFromJob(STEP, job(), job({ pollAttempt: 3 }), NOW);
    expect(out.kind === "waiting" && out.retryAfterMs).toBeGreaterThan(1_000);
  });

  it("восстановимый отказ отдаётся как повторяемый", () => {
    const out = outcomeFromJob(
      STEP,
      job(),
      job({ stage: "FAILED_RETRYABLE", lastErrorCode: "HTTP_502", lastError: "bad gateway" }),
      NOW
    );
    expect(out).toMatchObject({ kind: "failed", code: "HTTP_502", retryable: true });
  });

  it("терминальный отказ повторять нельзя", () => {
    const out = outcomeFromJob(
      STEP,
      job(),
      job({ stage: "FAILED_TERMINAL", lastErrorCode: "BAD_INPUT" }),
      NOW
    );
    expect(out).toMatchObject({ kind: "failed", retryable: false });
  });

  it("пауза прогона останавливает шаг, сохраняя место остановки", () => {
    // `skipped` считался улаженным состоянием и каскадом уносил конвейер в
    // «всё готово»; отказ конвейер останавливает и оставляет что возобновлять.
    expect(outcomeFromJob(STEP, job(), job({ cancelRequested: true }), NOW).kind).toBe("failed");
    expect(outcomeFromJob(STEP, job(), job({ stage: "CANCELLED" }), NOW).kind).toBe("failed");
  });

  it("готовый отчёт закрывает шаг", () => {
    expect(outcomeFromJob(STEP, job(), job({ stage: "REPORT_READY" }), NOW).kind).toBe("done");
    expect(outcomeFromJob(STEP, job(), job({ stage: "COMPLETED_PARTIAL" }), NOW).kind).toBe("done");
  });

  it("исчезнувшая джоба — невосстановимая ошибка, а не молчание", () => {
    const out = outcomeFromJob(STEP, job(), null, NOW);
    expect(out).toMatchObject({ kind: "failed", code: "JOB_DISAPPEARED", retryable: false });
  });

  it("шаг закрыт, если джоба обогнала его ещё до исполнения", () => {
    // Первый живой прогон: веб-процесс успевал продвинуть джобу на следующую
    // стадию раньше, чем воркер брал первый шаг. Сравнение «сдвинулась ли
    // джоба за этот вызов» давало «работа идёт» каждый раз — шаг ждал вечно,
    // сжигал бюджет попыток и останавливал конвейер.
    const base: WorkflowStepRow = { ...STEP, name: "BASE_COLLECTION", position: 1 };
    const ahead = job({ stage: "ARSENKIN_ENRICHMENT" });
    expect(outcomeFromJob(base, ahead, ahead, NOW).kind).toBe("done");
  });

  it("шаг ждёт, пока джоба стоит на его собственной стадии", () => {
    const base: WorkflowStepRow = { ...STEP, name: "BASE_COLLECTION", position: 1 };
    const here = job({ stage: "BASE_COLLECTION" });
    expect(outcomeFromJob(base, here, here, NOW).kind).toBe("waiting");
  });

  it("переход между внутренними стадиями шага подготовки не считается завершением", () => {
    // ORION_PREPARE → CLIENT_CONTENT — движение внутри одного шага REPORT_PREPARE.
    const prepare: WorkflowStepRow = { ...STEP, name: "REPORT_PREPARE", position: 4 };
    const out = outcomeFromJob(
      prepare,
      job({ stage: "ORION_PREPARE" }),
      job({ stage: "ORION_PREPARE" }),
      NOW
    );
    expect(out.kind).toBe("waiting");
  });
});
