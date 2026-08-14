import { describe, expect, it, vi } from "vitest";
import type { WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";

/**
 * Обработчик шага один на весь конвейер, и он выполняет текущую стадию джобы,
 * а не свою. Пока сборка отчёта идёт шесть минут, ждущий шаг обогащения
 * просыпается по расписанию, вызывает тот же тик — и отчёт собирается второй
 * раз параллельно. На живом прогоне чтение ста двадцати страниц и отрисовка
 * отработали дважды: платили вдвое.
 */

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

function step(name: string): WorkflowStepRow {
  return { id: `s-${name}`, jobId: "job-1", caseId: "case-1", name, attempt: 1 } as unknown as WorkflowStepRow;
}

function job(stage: string) {
  return {
    caseId: "case-1",
    stage,
    status: "RUNNING",
    compositeDatasetId: "ds-1",
    baseReportRunId: "base-1",
  };
}

describe("шаг, который джоба переросла", () => {
  it("не запускает работу: сборку отчёта не дублирует", async () => {
    const { unifiedStepHandlers } = await import(
      "@/modules/digital-profile/workflow/unified-step-handlers"
    );
    tick.mockClear();
    // Джоба уже собирает отчёт, а просыпается шаг обогащения (позиция 2).
    loadJob.mockResolvedValue(job("ORION_PREPARE"));
    const outcome = await unifiedStepHandlers()["ARSENKIN_ENRICHMENT"]!(step("ARSENKIN_ENRICHMENT"));
    expect(tick).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("done");
  });

  it("шаг своей стадии работу запускает", async () => {
    const { unifiedStepHandlers } = await import(
      "@/modules/digital-profile/workflow/unified-step-handlers"
    );
    tick.mockClear();
    loadJob.mockResolvedValue(job("ORION_PREPARE"));
    tick.mockResolvedValue(job("REPORT_READY"));
    await unifiedStepHandlers()["REPORT_PREPARE"]!(step("REPORT_PREPARE"));
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it("шаг, до которого джоба ещё не дошла, работу тоже запускает", async () => {
    const { unifiedStepHandlers } = await import(
      "@/modules/digital-profile/workflow/unified-step-handlers"
    );
    tick.mockClear();
    // Джоба на сборе базы (позиция 1), а проснулся шаг слияния (позиция 3):
    // порядок шагов обеспечивает конвейер, и запрещать здесь нечего.
    loadJob.mockResolvedValue(job("BASE_COLLECTION"));
    tick.mockResolvedValue(job("BASE_COLLECTION"));
    await unifiedStepHandlers()["COMPOSITE_MERGE"]!(step("COMPOSITE_MERGE"));
    expect(tick).toHaveBeenCalledTimes(1);
  });
});
