import { describe, expect, it, vi } from "vitest";
import { runOneStep } from "@/modules/digital-profile/workflow/step-runner";
import type { WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";

/**
 * Лиза шага выдаётся на две минуты, а сборка отчёта идёт шесть: чтение ста
 * двадцати страниц, разбор моделью, отрисовка. Без продления шаг посреди
 * работы снова становился свободным, второй воркер брал его и собирал тот же
 * отчёт параллельно — за один отчёт платили дважды.
 */

vi.mock("@/modules/digital-profile/workflow/step-store", () => ({
  claimNextStep: vi.fn(async () => STEP),
  completeStep: vi.fn(async () => undefined),
  releaseStepLease: vi.fn(async () => undefined),
  renewStepLease: vi.fn(async () => true),
}));

const STEP = {
  id: "step-1",
  jobId: "job-1",
  name: "ORION_PREPARE",
  attempt: 1,
} as unknown as WorkflowStepRow;

describe("продление лизы во время шага", () => {
  it("длинный шаг продлевает лизу, пока работает", async () => {
    vi.useFakeTimers();
    const renewLease = vi.fn(async () => true);
    let release!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<{ kind: "done" }>((resolve) => {
          release = () => resolve({ kind: "done" });
        })
    );

    const running = runOneStep({
      handlers: { ORION_PREPARE: handler as never },
      leaseMs: 120_000,
      renewLease,
      ownerId: "worker-1",
    });

    // Три четверти лизы: продление уже должно было сработать дважды.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(renewLease).toHaveBeenCalledWith("step-1", "worker-1", 120_000);
    expect(renewLease.mock.calls.length).toBeGreaterThanOrEqual(2);

    release();
    await running;
    const afterFinish = renewLease.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    // После завершения шага продление прекращается.
    expect(renewLease.mock.calls.length).toBe(afterFinish);
    vi.useRealTimers();
  });

  it("быстрый шаг лизу не продлевает", async () => {
    vi.useFakeTimers();
    const renewLease = vi.fn(async () => true);
    await runOneStep({
      handlers: { ORION_PREPARE: (async () => ({ kind: "done" })) as never },
      leaseMs: 120_000,
      renewLease,
      ownerId: "worker-1",
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renewLease).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("упавший шаг тоже прекращает продление", async () => {
    vi.useFakeTimers();
    const renewLease = vi.fn(async () => true);
    await runOneStep({
      handlers: {
        ORION_PREPARE: (async () => {
          throw new Error("шаг упал");
        }) as never,
      },
      leaseMs: 120_000,
      renewLease,
      ownerId: "worker-1",
      onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(renewLease).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
