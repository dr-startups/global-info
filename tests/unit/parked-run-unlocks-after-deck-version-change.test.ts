process.env.UNIFIED_COLLECTION_JOB_STORE = "file";

/**
 * Замок «уже провалилось так же» помнит, на какой версии деки это было.
 *
 * Отказ подготовки запирает у прогона две кнопки: детерминированный гейт —
 * «Возобновить», отметка `report-rebuild-failed:<код>` — «Пересобрать отчёт».
 * Пока оба замка не знали, при каком коде их закрыли, они переживали выкат
 * исправления: `lastError` очищает только само восстановление (то есть кнопка,
 * которую маркер и запирает), а отметку неудачной пересборки не снимает никто.
 * Прогон, чья пересборка однажды провалилась тем же кодом, оставался мёртвым
 * навсегда, и единственным выходом был новый платный сбор.
 *
 * Поэтому прогон, паркуясь на отказе, записывает версию содержимого деки, а оба
 * замка держат, только пока записанная версия равна нынешней. **Записи нет —
 * не держат**: так выглядят прогоны, вставшие до этого шага.
 *
 * Форма записи — часть контракта хранения (её пишет оркестратор, читают два
 * сервиса), поэтому здесь она названа строкой, а не импортом.
 *
 * Офлайн целиком: файловое хранилище, подставленная подготовка, подменённые
 * шаги конвейера.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import {
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedJobDir,
  writeUnifiedArtifact,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { prepareBlockedErrorFor } from "@/modules/digital-profile/services/canonical-report-prepare";
import { NarrativeOverBudgetError } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { DECK_CONTENT_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/content-version";
import { evaluateUnifiedCollectionRecoveryEligibility } from "@/modules/digital-profile/services/unified-collection-recovery";
import { evaluateUnifiedReportRebuildEligibility } from "@/modules/digital-profile/services/unified-report-rebuild";
import { REBUILD_MARKER } from "@/modules/digital-profile/services/unified-report-rebuild";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";
import {
  enrichmentState,
  failPrepareWith,
  seedPreparedRun,
  stepsAfterPrepare,
} from "../fixtures/parked-prepare-failure";

const pipeline = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/modules/digital-profile/workflow/step-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPipelineSteps: async () => pipeline.rows,
}));

const CASE = `unit-0039-version-lock-${Date.now()}`;
const NOW = new Date("2026-08-29T10:00:00.000Z");
const VERSION_PREFIX = "deck-content-version:";
const CURRENT_MARK = `${VERSION_PREFIX}${DECK_CONTENT_VERSION}`;
const STALE_MARK = `${VERSION_PREFIX}deck-sections-v1`;
const REBUILD_FAILED_MARK = "report-rebuild-failed:ASSEMBLY_QA_FAILED";

let composite = "";
let jobId = "";

const overBudget = () =>
  prepareBlockedErrorFor(
    new NarrativeOverBudgetError([
      { slideKey: "p13_ru_wikipedia", templateId: "wikipedia-check", length: 1013, budget: 998 },
    ])
  );

beforeAll(async () => {
  const seed = await seedPreparedRun(CASE);
  jobId = seed.unifiedJobId;
  composite = seed.compositeDatasetId;
});

afterAll(() => {
  rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
});

/** Прогон, вставший на детерминированном отказе подготовки. */
async function park(over?: Partial<UnifiedCollectionJob>): Promise<UnifiedCollectionJob> {
  return await failPrepareWith({
    caseId: CASE,
    compositeDatasetId: composite,
    error: overBudget(),
    now: NOW,
    job: over,
  });
}

/**
 * То же, но отказ случился на **пересборке**: так выглядит прогон владельца,
 * которому нажали «Пересобрать отчёт» до выката исправления.
 */
async function parkAfterFailedRebuild(): Promise<UnifiedCollectionJob> {
  await writeUnifiedArtifact(CASE, jobId, "unified-rebuild-audit.json", {
    restoreSnapshot: {
      stage: "FAILED_TERMINAL",
      status: "FAILED",
      progress: 0.9,
      completedAt: NOW.toISOString(),
      reportLinks: {},
      startedAt: NOW.toISOString(),
      lastError: `NARRATIVE_OVER_BUDGET=1 narrative over template budget: p13_ru_wikipedia [wikipedia-check] 1013>998`,
      lastErrorCode: "ASSEMBLY_QA_FAILED",
    },
  });
  return await park({ warnings: [REBUILD_MARKER] });
}

async function buttons(job: UnifiedCollectionJob) {
  pipeline.rows = stepsAfterPrepare(job, NOW);
  const recovery = await evaluateUnifiedCollectionRecoveryEligibility({ caseId: CASE, job, now: NOW });
  const rebuild = await evaluateUnifiedReportRebuildEligibility({ caseId: CASE, job, now: NOW });
  return { recovery, rebuild };
}

/** Та же джоба, но записанная версия деки подменена (или снята вовсе). */
function withVersionMark(job: UnifiedCollectionJob, mark: string | null): UnifiedCollectionJob {
  const rest = job.warnings.filter((w) => !w.startsWith(VERSION_PREFIX));
  return { ...job, warnings: mark ? [...rest, mark] : rest };
}

const versionMarks = (job: UnifiedCollectionJob) =>
  job.warnings.filter((w) => w.startsWith(VERSION_PREFIX));

describe("прогон записывает версию деки, на которой встал", () => {
  it("терминальный отказ подготовки — одной записью", async () => {
    const job = await park();

    expect(versionMarks(job)).toEqual([CURRENT_MARK]);
  });

  it("неудавшаяся пересборка — тоже, рядом с отметкой отказа", async () => {
    const job = await parkAfterFailedRebuild();

    expect(job.warnings).toContain(REBUILD_FAILED_MARK);
    expect(versionMarks(job)).toEqual([CURRENT_MARK]);
  });

  it("повторная парковка не копит записей и не оставляет двух версий", async () => {
    // Иначе замок читал бы первую попавшуюся: предупреждения схлопывают только
    // дословные дубли, а `v1` и `v146` — две разные строки.
    const first = await park();
    await patchUnifiedCollectionJob(CASE, {
      warnings: [...first.warnings.filter((w) => !w.startsWith(VERSION_PREFIX)), STALE_MARK],
    });
    const again = await park({ warnings: (await loadUnifiedCollectionJob(CASE))!.warnings });

    expect(versionMarks(again)).toEqual([CURRENT_MARK]);
  });
});

describe("оба замка держат ровно до смены версии деки", () => {
  it("нынешняя версия — обе кнопки заперты, как сегодня", async () => {
    const job = await parkAfterFailedRebuild();

    const { recovery, rebuild } = await buttons(job);

    expect(recovery.recoveryAllowed).toBe(false);
    expect(recovery.recoveryBlockerReason).toBe("PREPARE_GATE_NOT_FIXED_BY_RETRY");
    expect(rebuild.rebuildAllowed).toBe(false);
    expect(rebuild.rebuildBlockerReason).toBe("REBUILD_ALREADY_FAILED");
  });

  it("прежняя версия — обе кнопки открыты: код изменился", async () => {
    const job = withVersionMark(await parkAfterFailedRebuild(), STALE_MARK);

    const { recovery, rebuild } = await buttons(job);

    expect(recovery.recoveryAllowed).toBe(true);
    expect(recovery.recoveryBlockerReason).toBeNull();
    expect(rebuild.rebuildAllowed).toBe(true);
    expect(rebuild.rebuildBlockerReason).toBeNull();
  });

  it("записи версии нет — замки не держат", async () => {
    // Так выглядят прогоны, вставшие до этого шага: версии в их состоянии нет
    // и быть не может. Умолчание в сторону «кнопка есть»: цена ошибочного
    // отпирания — одна пересборка, которая запрётся снова уже с версией; цена
    // ошибочного запирания — мёртвый оплаченный прогон.
    const job = withVersionMark(await parkAfterFailedRebuild(), null);

    const { recovery, rebuild } = await buttons(job);

    expect(recovery.recoveryAllowed).toBe(true);
    expect(rebuild.rebuildAllowed).toBe(true);
  });
});

describe("прогон с неподведённым обогащением тоже получает выход", () => {
  /*
   * Побочный путь, названный ревьюером и подтверждённый зондом: ворота
   * готовности данных пропускаются на возобновлении с `RENDER`, поэтому
   * подготовка доходит до детерминированного отказа при `enrichmentComplete:
   * false`. Тогда пересборка заперта законно — там лежат оплаченные и не
   * подведённые наблюдения, — а «Возобновить» запирает сторож гейта, и обе
   * кнопки закрыты уже после первого отказа, без всякой пересборки.
   */
  it("после смены версии «Возобновить» возвращается, пересборка остаётся закрытой", async () => {
    const parked = await park({
      arsenkinEnrichmentState: enrichmentState(false),
      resumeCheckpoint: "RENDER",
    });
    expect(parked.stage).toBe("FAILED_TERMINAL");

    const before = await buttons(parked);
    expect(before.recovery.recoveryBlockerReason).toBe("PREPARE_GATE_NOT_FIXED_BY_RETRY");
    expect(before.rebuild.rebuildBlockerReason).toBe("ARSENKIN_INGEST_PENDING");

    const after = await buttons(withVersionMark(parked, STALE_MARK));

    expect(after.recovery.recoveryAllowed).toBe(true);
    // Пересборка остаётся закрытой своей причиной, и это верно: подводить
    // оплаченные наблюдения умеет не она.
    expect(after.rebuild.rebuildBlockerReason).toBe("ARSENKIN_INGEST_PENDING");
  });
});
