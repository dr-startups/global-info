import { describe, expect, it } from "vitest";
import {
  UNIFIED_PIPELINE,
  applyStepOutcome,
  deriveJobStage,
  nextRunnableStep,
  stepBackoffMs,
  stepIsRetryable,
  MAX_STEP_BACKOFF_MS,
} from "../../src/modules/digital-profile/workflow/step-plan";
import type { WorkflowStepRow } from "../../src/modules/digital-profile/workflow/step-types";

/**
 * Шаг 12 плана (docs/rework/12-durable-step-execution.md).
 *
 * Прогресс был представлен трижды: `job.stage` + `resumeCheckpoint`, блоб
 * `arsenkinEnrichmentState` и строки `ProviderTask`. Все дефекты шагов
 * 08.0-bis и 11.1 оказались расхождениями между этими представлениями.
 * Здесь состояние одно, и правила его продвижения проверяются напрямую.
 */

const NOW = new Date("2026-07-25T12:00:00.000Z");

function step(over: Partial<WorkflowStepRow> & Pick<WorkflowStepRow, "name" | "position">): WorkflowStepRow {
  return {
    id: `s-${over.name}`,
    caseId: "case-1",
    jobId: "job-1",
    state: "PENDING",
    attempts: 0,
    maxAttempts: 5,
    nextRunAt: null,
    leaseOwner: null,
    leaseUntil: null,
    inputHash: null,
    outputRef: null,
    lastError: null,
    lastErrorCode: null,
    ...over,
  };
}

/** Свежий конвейер, как его создаёт старт прогона. */
function pipeline(states: Partial<Record<string, Partial<WorkflowStepRow>>> = {}): WorkflowStepRow[] {
  return UNIFIED_PIPELINE.map((d) =>
    step({ name: d.name, position: d.position, maxAttempts: d.maxAttempts ?? 5, ...(states[d.name] ?? {}) })
  );
}

describe("выбор следующего шага", () => {
  it("берёт первый незавершённый по порядку", () => {
    const steps = pipeline({ BASE_COLLECTION: { state: "DONE" } });
    expect(nextRunnableStep(steps, NOW)?.name).toBe("ARSENKIN_ENRICHMENT");
  });

  it("не перескакивает через незавершённый шаг", () => {
    // COMPOSITE_MERGE готов, но ARSENKIN ещё ждёт — конвейер строго
    // последовательный, иначе слияние пошло бы по неполным данным.
    const steps = pipeline({
      BASE_COLLECTION: { state: "DONE" },
      ARSENKIN_ENRICHMENT: { state: "WAITING", nextRunAt: new Date(NOW.getTime() + 5_000) },
    });
    expect(nextRunnableStep(steps, NOW)).toBeNull();
  });

  it("будит шаг, когда его время наступило", () => {
    const steps = pipeline({
      BASE_COLLECTION: { state: "DONE" },
      ARSENKIN_ENRICHMENT: { state: "WAITING", nextRunAt: new Date(NOW.getTime() - 1) },
    });
    expect(nextRunnableStep(steps, NOW)?.name).toBe("ARSENKIN_ENRICHMENT");
  });

  it("не трогает шаг под живой чужой лизой", () => {
    const steps = pipeline({
      BASE_COLLECTION: { state: "RUNNING", leaseOwner: "other", leaseUntil: new Date(NOW.getTime() + 60_000) },
    });
    expect(nextRunnableStep(steps, NOW)).toBeNull();
  });

  it("подбирает шаг с истёкшей лизой — процесс, взявший его, умер", () => {
    const steps = pipeline({
      BASE_COLLECTION: { state: "RUNNING", leaseOwner: "dead", leaseUntil: new Date(NOW.getTime() - 1_000) },
    });
    expect(nextRunnableStep(steps, NOW)?.name).toBe("BASE_COLLECTION");
  });

  it("останавливает конвейер на упавшем шаге", () => {
    const steps = pipeline({ BASE_COLLECTION: { state: "FAILED" } });
    expect(nextRunnableStep(steps, NOW)).toBeNull();
  });

  it("пропускает пропущенные шаги", () => {
    const steps = pipeline({
      BASE_COLLECTION: { state: "DONE" },
      ARSENKIN_ENRICHMENT: { state: "SKIPPED" },
    });
    expect(nextRunnableStep(steps, NOW)?.name).toBe("COMPOSITE_MERGE");
  });

  it("на завершённом конвейере делать нечего", () => {
    const steps = pipeline(
      Object.fromEntries(UNIFIED_PIPELINE.map((d) => [d.name, { state: "DONE" as const }]))
    );
    expect(nextRunnableStep(steps, NOW)).toBeNull();
  });
});

describe("стадия джобы выводится из шагов", () => {
  it("свежий конвейер — первая стадия", () => {
    expect(deriveJobStage(pipeline())).toMatchObject({ stage: "BASE_COLLECTION", status: "WAITING" });
  });

  it("исполняющийся шаг даёт RUNNING", () => {
    const d = deriveJobStage(pipeline({ BASE_COLLECTION: { state: "RUNNING" } }));
    expect(d.status).toBe("RUNNING");
  });

  it("все шаги завершены — отчёт готов", () => {
    const steps = pipeline(
      Object.fromEntries(UNIFIED_PIPELINE.map((d) => [d.name, { state: "DONE" as const }]))
    );
    expect(deriveJobStage(steps)).toMatchObject({ stage: "REPORT_READY", status: "COMPLETED", progress: 1 });
  });

  it("отказ с оставшимися попытками восстановим", () => {
    const steps = pipeline({ ARSENKIN_ENRICHMENT: { state: "FAILED", attempts: 3, maxAttempts: 40 } });
    expect(deriveJobStage(steps).stage).toBe("FAILED_RETRYABLE");
  });

  it("исчерпанный бюджет попыток терминален", () => {
    const steps = pipeline({ ARSENKIN_ENRICHMENT: { state: "FAILED", attempts: 40, maxAttempts: 40 } });
    expect(deriveJobStage(steps).stage).toBe("FAILED_TERMINAL");
  });

  it("прогресс считается по доле завершённых шагов", () => {
    const steps = pipeline({ BASE_COLLECTION: { state: "DONE" }, ARSENKIN_ENRICHMENT: { state: "DONE" } });
    expect(deriveJobStage(steps).progress).toBeCloseTo(0.5);
  });

  it("пустой список не роняет вывод", () => {
    expect(deriveJobStage([])).toMatchObject({ stage: "BASE_COLLECTION", progress: 0 });
  });
});

describe("исход исполнения превращается в состояние", () => {
  it("успех закрывает шаг и снимает расписание", () => {
    const t = applyStepOutcome({ attempts: 2, maxAttempts: 5 }, { kind: "done", outputRef: "a.json" }, NOW);
    expect(t).toMatchObject({ state: "DONE", nextRunAt: null, outputRef: "a.json", finished: true });
  });

  it("успех не тратит попытку", () => {
    const t = applyStepOutcome({ attempts: 2, maxAttempts: 5 }, { kind: "done" }, NOW);
    expect(t.attempts).toBe(2);
  });

  it("ожидание планирует пробуждение и считается попыткой", () => {
    // Иначе шаг, у которого провайдер никогда не ответит, крутился бы вечно.
    const t = applyStepOutcome({ attempts: 0, maxAttempts: 40 }, { kind: "waiting" }, NOW);
    expect(t.state).toBe("WAITING");
    expect(t.attempts).toBe(1);
    expect(t.nextRunAt!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(t.finished).toBe(false);
  });

  it("ожидание уважает запрошенную провайдером паузу", () => {
    const t = applyStepOutcome({ attempts: 0, maxAttempts: 40 }, { kind: "waiting", retryAfterMs: 7_000 }, NOW);
    expect(t.nextRunAt!.getTime() - NOW.getTime()).toBe(7_000);
  });

  it("бесконечное ожидание упирается в бюджет и падает внятно", () => {
    const t = applyStepOutcome({ attempts: 39, maxAttempts: 40 }, { kind: "waiting" }, NOW);
    expect(t.state).toBe("FAILED");
    expect(t.lastErrorCode).toBe("STEP_ATTEMPTS_EXCEEDED");
    expect(t.finished).toBe(true);
  });

  it("восстановимая ошибка планирует повтор", () => {
    const t = applyStepOutcome(
      { attempts: 0, maxAttempts: 5 },
      { kind: "failed", code: "HTTP_502", message: "bad gateway", retryable: true },
      NOW
    );
    expect(t.state).toBe("FAILED");
    expect(t.nextRunAt).not.toBeNull();
    expect(t.finished).toBe(false);
  });

  it("невосстановимая ошибка повтор не планирует", () => {
    const t = applyStepOutcome(
      { attempts: 0, maxAttempts: 5 },
      { kind: "failed", code: "BAD_INPUT", message: "нет субъекта", retryable: false },
      NOW
    );
    expect(t.nextRunAt).toBeNull();
    expect(t.finished).toBe(true);
  });

  it("пропуск закрывает шаг с причиной", () => {
    const t = applyStepOutcome({ attempts: 0, maxAttempts: 5 }, { kind: "skipped", reason: "нет данных" }, NOW);
    expect(t).toMatchObject({ state: "SKIPPED", finished: true, lastError: "нет данных" });
  });
});

describe("задержка повтора", () => {
  it("растёт экспоненциально и упирается в потолок", () => {
    expect(stepBackoffMs(0)).toBe(2_000);
    expect(stepBackoffMs(1)).toBe(4_000);
    expect(stepBackoffMs(10)).toBe(MAX_STEP_BACKOFF_MS);
  });

  it("отрицательная попытка не даёт отрицательной паузы", () => {
    expect(stepBackoffMs(-5)).toBe(2_000);
  });
});

describe("ручной повтор", () => {
  it("доступен, пока бюджет не исчерпан", () => {
    expect(stepIsRetryable({ state: "FAILED", attempts: 2, maxAttempts: 5 })).toBe(true);
    expect(stepIsRetryable({ state: "FAILED", attempts: 5, maxAttempts: 5 })).toBe(false);
  });

  it("к работающему шагу не применяется", () => {
    expect(stepIsRetryable({ state: "WAITING", attempts: 1, maxAttempts: 5 })).toBe(false);
  });
});

describe("реестр конвейера", () => {
  it("позиции уникальны и идут подряд", () => {
    const positions = UNIFIED_PIPELINE.map((s) => s.position);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("имена уникальны", () => {
    const names = UNIFIED_PIPELINE.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
