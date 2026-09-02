process.env.UNIFIED_COLLECTION_JOB_STORE = "file";

/**
 * Одинаковый отказ сборки дважды — терминален со второй попытки.
 *
 * Прогон DPA-2026-0046 упал сборкой деки («required sections failed:
 * UAE_PROFILE/UAE_SUMMARY:FAILED (wikipedia denial…)») и повторил этот отказ
 * **десять раз** до `STEP_ATTEMPTS_EXHAUSTED`. Каждый круг — `resumeFrom:
 * "full"`, то есть заново оплаченные стадии модели 1, 1.5, 2 и 3.
 *
 * Автоматика не остановилась потому, что «лечится ли повтором» отвечалось
 * **списком имён гейтов** (`DETERMINISTIC_GATES`), а этого отказа в списке нет
 * и знака `=` он не несёт. Список отстаёт по построению: следующий гейт снова
 * стоил бы десяти оплат. Признак, который не отстаёт, — данные предыдущей
 * попытки: тот же код и тот же текст.
 *
 * Первая попытка остаётся платной и законной: ворота сборки читают текст
 * модели, и модель может написать иначе. Вторая одинаковая — доказательство
 * детерминизма.
 *
 * Офлайн целиком: файловое хранилище прогонов, подготовка подставлена через
 * `deps.runPrepare`, шаги конвейера подменены. Ни сети, ни базы, ни рендерера.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { unifiedJobDir } from "@/modules/digital-profile/services/unified-collection-job-store";
import { CanonicalPrepareBlockedError } from "@/modules/digital-profile/services/canonical-report-prepare";
import { evaluateUnifiedCollectionRecoveryEligibility } from "@/modules/digital-profile/services/unified-collection-recovery";
import { evaluateUnifiedReportRebuildEligibility } from "@/modules/digital-profile/services/unified-report-rebuild";
import { autoResumeState } from "@/modules/digital-profile/workflow/auto-resume";
import {
  PREPARE_REPEATED_FAILURE_MARK,
  parkedOnRepeatedFailure,
  repeatsPreviousFailure,
} from "@/modules/digital-profile/services/prepare-repeat";
import { prepareRetryIsPointless } from "@/modules/digital-profile/services/parked-deck-version";
import { DECK_CONTENT_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/content-version";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";
import type { WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";
import {
  failPrepareWith as failPrepare,
  seedPreparedRun,
  stepsAfterPrepare,
} from "../fixtures/parked-prepare-failure";

const pipeline = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/modules/digital-profile/workflow/step-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPipelineSteps: async () => pipeline.rows,
}));

const CASE = `unit-0050-repeat-${Date.now()}`;
const NOW = new Date("2026-09-02T21:00:00.000Z");
let composite = "";

/** Отказ ровно того вида, на котором встал прогон Борисова. */
const SECTIONS_MESSAGE =
  "deck assembly failed: required sections failed: UAE_PROFILE/UAE_SUMMARY:FAILED " +
  "(wikipedia denial contradicts page evidence on p24_uae_summary: en.wikipedia.org/wiki/Alexei_Borisov) " +
  "— build stopped";

const sectionsFailure = (message = SECTIONS_MESSAGE) =>
  new CanonicalPrepareBlockedError("ASSEMBLY_FAILED", message);

beforeAll(async () => {
  const seed = await seedPreparedRun(CASE);
  composite = seed.compositeDatasetId;
});

afterAll(() => {
  rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
});

async function failWith(
  err: unknown,
  over?: Partial<UnifiedCollectionJob>
): Promise<UnifiedCollectionJob> {
  return await failPrepare({
    caseId: CASE,
    compositeDatasetId: composite,
    error: err,
    now: NOW,
    job: { warnings: [], ...over },
  });
}

/** Джоба второй попытки: отказ первой лежит на ней и никем не очищен. */
const afterFirstAttempt = (message = SECTIONS_MESSAGE, code = "ASSEMBLY_FAILED") => ({
  lastError: message,
  lastErrorCode: code,
  warnings: ["retryable-assembly-failure", "CANONICAL_PREPARE_BLOCKED"],
});

const recoveryFor = async (job: UnifiedCollectionJob, rows: WorkflowStepRow[]) => {
  pipeline.rows = rows;
  return await evaluateUnifiedCollectionRecoveryEligibility({ caseId: CASE, job, now: NOW });
};

describe("одинаковый отказ сборки дважды", () => {
  it("первая попытка остаётся возобновляемой: модель может написать иначе", async () => {
    const job = await failWith(sectionsFailure());

    expect(job.stage).toBe("FAILED_RETRYABLE");
    expect(job.resumeCheckpoint).toBe("ASSEMBLY");
    expect(job.warnings).toContain("retryable-assembly-failure");
    expect(job.warnings).not.toContain(PREPARE_REPEATED_FAILURE_MARK);
  });

  it("вторая попытка с тем же кодом и текстом паркует прогон", async () => {
    const job = await failWith(sectionsFailure(), afterFirstAttempt());

    expect(job.stage).toBe("FAILED_TERMINAL");
    expect(job.warnings).toContain(PREPARE_REPEATED_FAILURE_MARK);
    expect(job.warnings).toContain(`deck-content-version:${DECK_CONTENT_VERSION}`);
    expect(job.warnings).toContain("CANONICAL_PREPARE_BLOCKED");
    /*
     * Признак того, что `failRetryable` не звался, — статус, а не
     * предупреждения: пометку `retryable-assembly-failure` оставила первая
     * попытка, и она законно остаётся на джобе. `failRetryable` ставит
     * `WAITING`, терминальный путь — `FAILED`, и это проверено выше.
     */
    expect(job.status).toBe("FAILED");
  });

  it("оператор читает объяснение, а машинный текст остаётся для диагностики", async () => {
    const job = await failWith(sectionsFailure(), afterFirstAttempt());

    expect(job.lastError).toContain("дважды подряд отказала одинаково");
    expect(job.lastError).toContain("Пересобрать отчёт");
    expect(job.lastError).toContain(SECTIONS_MESSAGE);
  });

  it("повторного захода конвейеру не назначает", async () => {
    const steps = stepsAfterPrepare(await failWith(sectionsFailure(), afterFirstAttempt()), NOW);
    const prepare = steps[steps.length - 1]!;

    expect(prepare.state).toBe("FAILED");
    expect(prepare.nextRunAt).toBeNull();
    expect(autoResumeState(steps, NOW).pending).toBe(false);
  });

  it("кнопка «Возобновить» закрыта названной причиной, «Пересобрать отчёт» — открыта", async () => {
    const job = await failWith(sectionsFailure(), afterFirstAttempt());
    const steps = stepsAfterPrepare(job, NOW);

    const recovery = await recoveryFor(job, steps);
    expect(recovery.recoveryAllowed).toBe(false);
    expect(recovery.recoveryBlockerReason).toBe("PREPARE_GATE_NOT_FIXED_BY_RETRY");

    // Выход из парковки — пересборка после выката исправления.
    const rebuild = await evaluateUnifiedReportRebuildEligibility({
      caseId: CASE,
      job,
      now: NOW,
      autoResumePending: false,
    });
    expect(rebuild.rebuildAllowed).toBe(true);
  });

  it("тот же код, но другой текст — повтор законен", async () => {
    // Ворота сборки читают текст модели: второй заход может дать другой ответ.
    const job = await failWith(
      sectionsFailure("deck assembly failed: required sections failed: RU_SUMMARY:FAILED — build stopped"),
      afterFirstAttempt()
    );

    expect(job.stage).toBe("FAILED_RETRYABLE");
    expect(job.warnings).not.toContain(PREPARE_REPEATED_FAILURE_MARK);
  });

  it("тот же текст, но другой код — повтор законен", async () => {
    const job = await failWith(
      sectionsFailure(),
      afterFirstAttempt(SECTIONS_MESSAGE, "ASSEMBLY_QA_FAILED")
    );

    expect(job.stage).toBe("FAILED_RETRYABLE");
    expect(job.warnings).not.toContain(PREPARE_REPEATED_FAILURE_MARK);
  });

  it("неполная подводка живёт своей веткой: повторяется подводка, а не сборка", async () => {
    // «Ожидание — не попытка»: подводятся оплаченные наблюдения Arsenkin.
    const job = await failWith(sectionsFailure(), {
      ...afterFirstAttempt(),
      warnings: [...afterFirstAttempt().warnings, "arsenkin-skipped:no-base"],
    });

    expect(job.stage).toBe("FAILED_RETRYABLE");
    expect(job.warnings).not.toContain(PREPARE_REPEATED_FAILURE_MARK);
  });
});

describe("замок парковки по повтору", () => {
  it("держит, пока версия деки не сменилась", () => {
    const parked = {
      lastError: SECTIONS_MESSAGE,
      warnings: [PREPARE_REPEATED_FAILURE_MARK, `deck-content-version:${DECK_CONTENT_VERSION}`],
    };

    expect(prepareRetryIsPointless(parked)).toBe(true);
  });

  it("отпирается сменой версии деки — выкат исправления оживляет прогон", () => {
    const parked = {
      lastError: SECTIONS_MESSAGE,
      warnings: [PREPARE_REPEATED_FAILURE_MARK, "deck-content-version:deck-sections-v1"],
    };

    expect(prepareRetryIsPointless(parked)).toBe(false);
  });

  it("без пометки повтора и без гейта замок не держит", () => {
    expect(
      prepareRetryIsPointless({
        lastError: SECTIONS_MESSAGE,
        warnings: [`deck-content-version:${DECK_CONTENT_VERSION}`],
      })
    ).toBe(false);
  });
});

describe("чистые функции признака", () => {
  it("повтор — это тот же код и тот же текст", () => {
    expect(
      repeatsPreviousFailure(
        { lastError: SECTIONS_MESSAGE, lastErrorCode: "ASSEMBLY_FAILED" },
        "ASSEMBLY_FAILED",
        SECTIONS_MESSAGE
      )
    ).toBe(true);
  });

  it("отличие в один знак повтором не считается", () => {
    // Сравнение дословное: подгонять его под «похожие» строки значило бы
    // вернуть догадку, от которой шаг и уходит.
    expect(
      repeatsPreviousFailure(
        { lastError: SECTIONS_MESSAGE, lastErrorCode: "ASSEMBLY_FAILED" },
        "ASSEMBLY_FAILED",
        `${SECTIONS_MESSAGE}.`
      )
    ).toBe(false);
  });

  it("первая попытка повтором не является", () => {
    expect(
      repeatsPreviousFailure({ lastError: null, lastErrorCode: null }, "ASSEMBLY_FAILED", SECTIONS_MESSAGE)
    ).toBe(false);
  });

  it("пометку парковки читает ровно своя функция", () => {
    expect(parkedOnRepeatedFailure([PREPARE_REPEATED_FAILURE_MARK])).toBe(true);
    expect(parkedOnRepeatedFailure(["CANONICAL_PREPARE_BLOCKED"])).toBe(false);
    expect(parkedOnRepeatedFailure(null)).toBe(false);
  });
});
