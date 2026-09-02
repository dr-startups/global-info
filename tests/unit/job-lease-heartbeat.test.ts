import { describe, expect, it, vi } from "vitest";

/**
 * Отчёт собирался дважды за прогон. Лиза джобы берётся на две минуты, а сборка
 * идёт шесть: чтение ста двадцати страниц, разбор моделью, отрисовка.
 * Подборщик прогонов опрашивает джобы каждые пять секунд — как только лиза
 * истекала, он запускал второй тик той же джобы, и сборка шла параллельно сама
 * с собой. Промежуток между двойными строками в логе равен длине лизы.
 */

const claim = vi.fn();
const release = vi.fn(async () => undefined);
const load = vi.fn(async () => null);

vi.mock("@/modules/digital-profile/services/unified-collection-job-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimUnifiedJobLease: (...args: unknown[]) => claim(...args),
  releaseUnifiedJobLease: (...args: unknown[]) => release(...(args as [])),
  loadUnifiedCollectionJob: (...args: unknown[]) => load(...(args as [])),
  patchUnifiedCollectionJob: vi.fn(async () => null),
}));

const JOB = {
  caseId: "case-1",
  unifiedJobId: "u-1",
  stage: "REPORT_READY",
  status: "COMPLETED",
  cancelRequested: false,
  warnings: [],
};

describe("продление лизы джобы", () => {
  it("длинный тик продлевает лизу, пока работает", async () => {
    vi.useFakeTimers();
    claim.mockClear();
    claim.mockResolvedValue(JOB);

    const { runUnifiedCollectionTick, JOB_LEASE_MS, JOB_LEASE_HEARTBEAT_MS } = await import(
      "@/modules/digital-profile/services/unified-orion-collection-orchestrator"
    );

    let release!: () => void;
    load.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(JOB as never);
        }) as never
    );

    const running = runUnifiedCollectionTick("case-1");
    await vi.advanceTimersByTimeAsync(JOB_LEASE_HEARTBEAT_MS * 2 + 1_000);

    // Первый вызов — захват лизы, дальше только продления той же лизы.
    expect(claim.mock.calls.length).toBeGreaterThanOrEqual(3);
    for (const [args] of claim.mock.calls) {
      expect((args as { leaseMs: number }).leaseMs).toBe(JOB_LEASE_MS);
    }
    const owners = new Set(claim.mock.calls.map(([a]) => (a as { ownerId: string }).ownerId));
    expect(owners.size).toBe(1);

    release();
    await running;
    const afterFinish = claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(JOB_LEASE_MS * 3);
    // Тик закончился — продление прекратилось.
    expect(claim.mock.calls.length).toBe(afterFinish);
    vi.useRealTimers();
  });

  it("без захвата лизы тик не работает и не продлевает", async () => {
    vi.useFakeTimers();
    claim.mockClear();
    claim.mockResolvedValue(null);
    load.mockResolvedValue(null as never);

    const { runUnifiedCollectionTick, JOB_LEASE_MS } = await import(
      "@/modules/digital-profile/services/unified-orion-collection-orchestrator"
    );
    await runUnifiedCollectionTick("case-1");
    await vi.advanceTimersByTimeAsync(JOB_LEASE_MS * 3);
    expect(claim).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
