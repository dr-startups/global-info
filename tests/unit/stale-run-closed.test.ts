/**
 * Прогон, который перестал двигаться, закрывается, а не опрашивается вечно.
 *
 * Подборщик берёт джобы в активных стадиях каждые пять секунд. Джоба,
 * застрявшая в такой стадии, остаётся в выборке навсегда: в логе вторые сутки
 * шло «подобрано прогонов: 1» от кейса, который никуда не двигался. Вреда от
 * него мало, но признак «работа идёт» он делает бессмысленным, а оператор не
 * видит, что прогон давно не жив.
 */

import { describe, expect, it, vi } from "vitest";

const claim = vi.fn();
const patch = vi.fn(async (_caseId: string, p: Record<string, unknown>) => ({ ...JOB, ...p }));
const load = vi.fn(async () => JOB);

vi.mock("@/modules/digital-profile/services/unified-collection-job-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimUnifiedJobLease: (...args: unknown[]) => claim(...args),
  releaseUnifiedJobLease: vi.fn(async () => undefined),
  loadUnifiedCollectionJob: (...args: unknown[]) => load(...(args as [])),
  patchUnifiedCollectionJob: (...args: unknown[]) =>
    patch(...(args as [string, Record<string, unknown>])),
}));

const JOB = {
  caseId: "case-1",
  unifiedJobId: "u-1",
  stage: "ARSENKIN_ENRICHMENT",
  status: "RUNNING",
  cancelRequested: false,
  warnings: [],
  startedAt: "2026-08-16T00:00:00.000Z",
};

describe("предельный возраст прогона", () => {
  it("прогон старше шести часов останавливается с понятной причиной", async () => {
    const { runUnifiedCollectionTick, UNIFIED_RUN_MAX_MS } = await import(
      "@/modules/digital-profile/services/unified-orion-collection-orchestrator"
    );
    claim.mockClear();
    patch.mockClear();
    claim.mockResolvedValue(JOB);

    const started = Date.parse(JOB.startedAt);
    await runUnifiedCollectionTick("case-1", {
      now: () => new Date(started + UNIFIED_RUN_MAX_MS + 60_000),
    } as never);

    expect(patch).toHaveBeenCalledTimes(1);
    const [, patched] = patch.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(patched.stage).toBe("FAILED_TERMINAL");
    expect(patched.lastErrorCode).toBe("STALE_NO_PROGRESS");
    // Оператору говорим, что делать, а не только код.
    expect(String(patched.lastError)).toContain("Запустите сбор заново");
  });

  it("прогон в пределах срока работает как обычно", async () => {
    const { runUnifiedCollectionTick, UNIFIED_RUN_MAX_MS } = await import(
      "@/modules/digital-profile/services/unified-orion-collection-orchestrator"
    );
    claim.mockClear();
    patch.mockClear();
    claim.mockResolvedValue(JOB);

    const started = Date.parse(JOB.startedAt);
    await runUnifiedCollectionTick("case-1", {
      now: () => new Date(started + UNIFIED_RUN_MAX_MS - 60_000),
    } as never);

    const stale = patch.mock.calls.some(
      ([, p]) => (p as Record<string, unknown>).lastErrorCode === "STALE_NO_PROGRESS"
    );
    expect(stale).toBe(false);
  });

  it("джоба без отметки о старте по возрасту не закрывается", async () => {
    const { runUnifiedCollectionTick } = await import(
      "@/modules/digital-profile/services/unified-orion-collection-orchestrator"
    );
    claim.mockClear();
    patch.mockClear();
    claim.mockResolvedValue({ ...JOB, startedAt: undefined });

    await runUnifiedCollectionTick("case-1", { now: () => new Date(2 ** 42) } as never);

    const stale = patch.mock.calls.some(
      ([, p]) => (p as Record<string, unknown>).lastErrorCode === "STALE_NO_PROGRESS"
    );
    expect(stale).toBe(false);
  });
});
