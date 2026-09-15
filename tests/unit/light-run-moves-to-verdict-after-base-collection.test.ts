process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
process.env.NETWORK_CALLS = "0";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import {
  LIGHT_RUN_SKIPPED_PROVIDERS,
  runUnifiedCollectionTick,
  startUnifiedOrionCollection,
  type UnifiedOrchestratorDeps,
} from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { jobMode, type UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";
import type { FullAuditRunOptions } from "@/modules/digital-profile/services/agent-run-service";
import { FIXTURE_BASE_ROWS, personaDecided, realFullAudit } from "../support/light-run-fixtures";

/**
 * После базового сбора лёгкая джоба идёт на вердикт, а полная — в обогащение.
 *
 * Режим живёт в самой джобе: воркер берёт шаг из базы, а не из памяти запроса,
 * и после деплоя посреди сбора он обязан знать, какой это прогон. Базовый сбор
 * общий, но спрашивает он разное: лёгкий прогон просит риск-пробы и не зовёт
 * зарубежный контур — у проверки с сайта регион один, Россия.
 */

const LIGHT = "case-light-moves-to-verdict";
const FULL = "case-full-moves-to-enrichment";

beforeEach(async () => {
  await deleteUnifiedCollectionJobForTests(LIGHT);
  await deleteUnifiedCollectionJobForTests(FULL);
});

afterEach(async () => {
  await deleteUnifiedCollectionJobForTests(LIGHT);
  await deleteUnifiedCollectionJobForTests(FULL);
});

function auditSpy() {
  return vi.fn(async (_caseId: string, _actorId: string, _options?: FullAuditRunOptions) => realFullAudit());
}

function deps(over: Partial<UnifiedOrchestratorDeps> = {}): UnifiedOrchestratorDeps {
  return {
    autoSchedule: false,
    fixtureBaseRows: FIXTURE_BASE_ROWS,
    runFullAudit: auditSpy(),
    ...personaDecided,
    ...over,
  };
}

async function startLight(d: UnifiedOrchestratorDeps) {
  await startUnifiedOrionCollection({
    caseId: LIGHT,
    requestedBy: "self-check:check-1",
    mode: "light",
    deps: d,
  });
}

describe("режим прогона живёт в джобе", () => {
  it("старт в лёгком режиме записывает режим в джобу", async () => {
    await startLight(deps());
    const job = await loadUnifiedCollectionJob(LIGHT);
    expect(job?.mode).toBe("light");
    expect(job?.requestedBy).toBe("self-check:check-1");
  });

  it("старт без режима — полный прогон, как из админки", async () => {
    await startUnifiedOrionCollection({ caseId: FULL, requestedBy: "staff", deps: deps() });
    expect(jobMode((await loadUnifiedCollectionJob(FULL)) as UnifiedCollectionJob)).toBe("full");
  });
});

describe("после базового сбора", () => {
  it("лёгкая джоба уходит на вердикт, а не в обогащение", async () => {
    const recordLightVerdict = vi.fn(async () => {});
    const d = deps({ recordLightVerdict });
    await startLight(d);
    const job = await runUnifiedCollectionTick(LIGHT, d);
    expect(job?.stage).toBe("LIGHT_VERDICT");
    expect(job?.status).toBe("RUNNING");
    expect(recordLightVerdict).not.toHaveBeenCalled();
  });

  it("базовый сбор лёгкой джобы просит риск-пробы и не зовёт зарубежный контур", async () => {
    const runFullAudit = auditSpy();
    const d = deps({ runFullAudit });
    await startLight(d);
    await runUnifiedCollectionTick(LIGHT, d);
    expect(runFullAudit).toHaveBeenCalledTimes(1);
    const [caseId, actorId, options] = runFullAudit.mock.calls[0]!;
    expect([caseId, actorId]).toEqual([LIGHT, "self-check:check-1"]);
    expect(options).toMatchObject({ includeRiskProbes: true });
    expect(options?.skipProviders).toEqual([...LIGHT_RUN_SKIPPED_PROVIDERS]);
    expect(LIGHT_RUN_SKIPPED_PROVIDERS).toContain("orion_uae_international");
  });

  it("шаг вердикта записывает вердикт и завершает джобу стадией LIGHT_READY", async () => {
    const recordLightVerdict = vi.fn(async (_job: UnifiedCollectionJob) => {});
    const d = deps({ recordLightVerdict });
    await startLight(d);
    await runUnifiedCollectionTick(LIGHT, d);
    const done = await runUnifiedCollectionTick(LIGHT, d);
    expect(recordLightVerdict).toHaveBeenCalledTimes(1);
    expect(recordLightVerdict.mock.calls[0]![0]).toMatchObject({ caseId: LIGHT, mode: "light" });
    expect(done).toMatchObject({
      stage: "LIGHT_READY",
      status: "COMPLETED",
      progress: 1,
      completeness: "full",
    });
  });

  it("сбой записи вердикта — повторяемый отказ шага, а не готовая джоба", async () => {
    const d = deps({
      recordLightVerdict: async () => {
        throw new Error("база недоступна");
      },
    });
    await startLight(d);
    await runUnifiedCollectionTick(LIGHT, d);
    const failed = await runUnifiedCollectionTick(LIGHT, d);
    expect(failed).toMatchObject({ stage: "FAILED_RETRYABLE", lastErrorCode: "LIGHT_VERDICT_FAILED" });
  });

  it("полная джоба после сбора, как и раньше, идёт в обогащение — без риск-проб и пропусков", async () => {
    const runFullAudit = auditSpy();
    const d = deps({ runFullAudit });
    await startUnifiedOrionCollection({ caseId: FULL, requestedBy: "staff", deps: d });
    const job = await runUnifiedCollectionTick(FULL, d);
    expect(job?.stage).toBe("ARSENKIN_ENRICHMENT");
    const options = runFullAudit.mock.calls[0]![2];
    // В окружении теста ORION_INCLUDE_RISK_PROBES не задан: полный прогон
    // спрашивает ровно то, что спрашивал до этапа.
    expect(options).toMatchObject({ includeRiskProbes: false });
    expect(options?.skipProviders ?? []).toEqual([]);
  });
});
