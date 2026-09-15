process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
process.env.NETWORK_CALLS = "0";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import {
  persistUnifiedTickFailure,
  runUnifiedCollectionTick,
  startUnifiedOrionCollection,
  type UnifiedOrchestratorDeps,
} from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { evaluateUnifiedReportRebuildEligibility } from "@/modules/digital-profile/services/unified-report-rebuild";
import { evaluateUnifiedGptCopyRetryEligibility } from "@/modules/digital-profile/services/unified-gpt-copy-retry";
import type { UnifiedCollectionStage } from "@/modules/digital-profile/services/unified-collection-types";
import { FIXTURE_BASE_ROWS, personaDecided, realFullAudit } from "../support/light-run-fixtures";

/**
 * Лёгкий прогон не доходит ни до Arsenkin, ни до GPT, ни до рендерера.
 *
 * Отсутствия шагов в плане мало. Обработчик у шагов один и исполняет
 * **текущую стадию джобы**, а исключение тика записывалось как сбой опроса
 * Arsenkin и ставило джобу в `ARSENKIN_ENRICHMENT`. Лёгкая джоба с упавшим
 * базовым сбором следующим тиком ушла бы в платные отправки обогащения — за
 * проверку, которую сайт обещал сделать без него. Поэтому диспетчер исполняет
 * только стадии плана своего режима, а чужая стадия — терминальный отказ.
 */

const CASE = "case-light-never-arsenkin";

beforeEach(async () => {
  await deleteUnifiedCollectionJobForTests(CASE);
});

afterEach(async () => {
  await deleteUnifiedCollectionJobForTests(CASE);
});

function guarded() {
  const runArsenkinEnrichment = vi.fn(async (): Promise<never> => {
    throw new Error("обогащение в лёгком прогоне");
  });
  const runPrepare = vi.fn(async (): Promise<never> => {
    throw new Error("подготовка отчёта в лёгком прогоне");
  });
  const recordLightVerdict = vi.fn(async () => {});
  const deps: UnifiedOrchestratorDeps = {
    autoSchedule: false,
    fixtureBaseRows: FIXTURE_BASE_ROWS,
    runFullAudit: async () => realFullAudit(),
    runArsenkinEnrichment,
    runPrepare,
    recordLightVerdict,
    ...personaDecided,
  };
  return { deps, runArsenkinEnrichment, runPrepare, recordLightVerdict };
}

async function startLight(deps: UnifiedOrchestratorDeps) {
  await startUnifiedOrionCollection({
    caseId: CASE,
    requestedBy: "self-check:check-1",
    mode: "light",
    deps,
  });
}

describe("лёгкий прогон целиком", () => {
  it("доходит до LIGHT_READY, ни разу не позвав обогащение и подготовку", async () => {
    const g = guarded();
    await startLight(g.deps);
    const stages: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const job = await runUnifiedCollectionTick(CASE, g.deps);
      stages.push(String(job?.stage));
      if (job?.stage === "LIGHT_READY" || String(job?.stage).startsWith("FAILED")) break;
    }
    expect(stages).toEqual(["LIGHT_VERDICT", "LIGHT_READY"]);
    expect(g.runArsenkinEnrichment).not.toHaveBeenCalled();
    expect(g.runPrepare).not.toHaveBeenCalled();
    expect(g.recordLightVerdict).toHaveBeenCalledTimes(1);
  });
});

describe("сторож тика: стадию чужого плана джоба не исполняет", () => {
  it.each(["ARSENKIN_ENRICHMENT", "COMPOSITE_MERGE", "ORION_PREPARE", "CLIENT_CONTENT"])(
    "лёгкая джоба в %s — терминальный отказ без вызова обработчика",
    async (stage) => {
      const g = guarded();
      await startLight(g.deps);
      await patchUnifiedCollectionJob(CASE, { stage: stage as UnifiedCollectionStage, status: "RUNNING" });
      const job = await runUnifiedCollectionTick(CASE, g.deps);
      expect(job).toMatchObject({ stage: "FAILED_TERMINAL", lastErrorCode: "RUN_MODE_STAGE_REFUSED" });
      expect(g.runArsenkinEnrichment).not.toHaveBeenCalled();
      expect(g.runPrepare).not.toHaveBeenCalled();
    }
  );

  it("полная джоба в стадии вердикта тоже отказывает: у каждого режима свой план", async () => {
    const g = guarded();
    await startUnifiedOrionCollection({ caseId: CASE, requestedBy: "staff", deps: g.deps });
    await patchUnifiedCollectionJob(CASE, { stage: "LIGHT_VERDICT" as UnifiedCollectionStage, status: "RUNNING" });
    const job = await runUnifiedCollectionTick(CASE, g.deps);
    expect(job).toMatchObject({ stage: "FAILED_TERMINAL", lastErrorCode: "RUN_MODE_STAGE_REFUSED" });
    expect(g.recordLightVerdict).not.toHaveBeenCalled();
  });
});

describe("исключение тика", () => {
  it("у лёгкой джобы — повторяемый отказ без ожидания Arsenkin", async () => {
    const g = guarded();
    await startLight(g.deps);
    const job = await persistUnifiedTickFailure(CASE, new Error("соединение с базой потеряно"));
    expect(job?.stage).toBe("FAILED_RETRYABLE");
    expect(job?.resumeCheckpoint ?? null).toBeNull();
  });

  it("у полной джобы — прежнее поведение: ожидание опроса Arsenkin", async () => {
    // Контроль: ветка лёгкого режима не должна менять то, на что опирается
    // возобновление полного прогона.
    const g = guarded();
    await startUnifiedOrionCollection({ caseId: CASE, requestedBy: "staff", deps: g.deps });
    const job = await persistUnifiedTickFailure(CASE, new Error("poll failed"));
    expect(job?.stage).toBe("ARSENKIN_ENRICHMENT");
    expect(job?.resumeCheckpoint).toBe("ARSENKIN_RESULT_INGEST");
  });
});

describe("действия админки над готовой лёгкой джобой", () => {
  it("пересобрать отчёт и повторить копию GPT нельзя: отчёта у лёгкого прогона нет", async () => {
    const g = guarded();
    await startLight(g.deps);
    await patchUnifiedCollectionJob(CASE, {
      stage: "LIGHT_READY" as UnifiedCollectionStage,
      status: "COMPLETED",
      progress: 1,
    });
    const job = await loadUnifiedCollectionJob(CASE);
    const rebuild = await evaluateUnifiedReportRebuildEligibility({
      caseId: CASE,
      job,
      autoResumePending: false,
      ignoreLease: true,
    });
    expect(rebuild).toMatchObject({ rebuildAllowed: false, rebuildBlockerReason: "LIGHT_RUN_HAS_NO_REPORT" });
    const gpt = await evaluateUnifiedGptCopyRetryEligibility({ caseId: CASE, job, ignoreLease: true });
    expect(gpt).toMatchObject({
      gptCopyRetryAllowed: false,
      gptCopyRetryBlockerReason: "LIGHT_RUN_HAS_NO_REPORT",
    });
  });
});
