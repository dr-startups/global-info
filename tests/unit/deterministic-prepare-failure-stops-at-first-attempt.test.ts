process.env.UNIFIED_COLLECTION_JOB_STORE = "file";

/**
 * Отказ, который повтор не лечит, останавливает прогон один раз, а не десять.
 *
 * Два оплаченных прогона владельца встали на собственном стороже сборки
 * («narrative over template budget: p13_ru_wikipedia …»), и конвейер пометил
 * отказ возобновляемым: `FAILED_RETRYABLE` + `resumeCheckpoint: ASSEMBLY`, то
 * есть `resumeFrom: "full"`. Каждый такой круг заново вызывает OpenAI на
 * стадиях 1, 1.5, 2 (принудительно) и 3, а бюджет отказов шага
 * `REPORT_PREPARE` — десять попыток. Дефект при этом детерминированный: те же
 * паки дают тот же текст и ту же длину.
 *
 * Здесь закреплена цена: такой отказ уходит терминальным путём с первой
 * попытки, повторного захода конвейеру не назначается, а кнопка
 * восстановления — тот же платный прогон подготовки — закрыта причиной
 * `PREPARE_GATE_NOT_FIXED_BY_RETRY`. Отказ **ворот сборки** с тем же кодом
 * читает текст модели, и у него повтор законен: он обязан остаться прежним.
 *
 * Офлайн целиком: файловое хранилище прогонов, подготовка подставлена через
 * `deps.runPrepare`, шаги конвейера подменены. Ни сети, ни базы, ни рендерера.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { unifiedJobDir } from "@/modules/digital-profile/services/unified-collection-job-store";
import {
  CanonicalPrepareBlockedError,
  prepareBlockedErrorFor,
} from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  NarrativeOverBudgetError,
  NarrativeReflowLossError,
} from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { NarrativeSplitLossError } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { blockingIssues } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import { evaluateUnifiedCollectionRecoveryEligibility } from "@/modules/digital-profile/services/unified-collection-recovery";
import { evaluateUnifiedReportRebuildEligibility } from "@/modules/digital-profile/services/unified-report-rebuild";
import { autoResumeState } from "@/modules/digital-profile/workflow/auto-resume";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";
import type { WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";
import {
  failPrepareWith as failPrepare,
  seedPreparedRun,
  stepsAfterPrepare,
} from "../fixtures/parked-prepare-failure";

/** Строки шагов прогона: восстановление спрашивает их первыми. */
const pipeline = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/modules/digital-profile/workflow/step-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPipelineSteps: async () => pipeline.rows,
}));

const CASE = `unit-0039-deterministic-${Date.now()}`;
const NOW = new Date("2026-08-29T10:00:00.000Z");
let jobId = "";
let composite = "";

/** Отказ ровно того вида, на котором встали прогоны владельца. */
const overBudget = () =>
  prepareBlockedErrorFor(
    new NarrativeOverBudgetError([
      { slideKey: "p13_ru_wikipedia", templateId: "wikipedia-check", length: 1013, budget: 998 },
      { slideKey: "p29_uae_wikipedia", templateId: "wikipedia-check", length: 1101, budget: 998 },
    ])
  );

const reflowLoss = () =>
  prepareBlockedErrorFor(new NarrativeReflowLossError([{ slideKey: "p03_persona", before: 403, after: 344 }]));

/** Разбивка абзаца по листам не смогла обойтись без потери знаков. */
const splitLoss = () => prepareBlockedErrorFor(new NarrativeSplitLossError("p13_ru_wikipedia", 1200, 998));

/**
 * Отказ ворот сборки: тот же код, другая природа — читается текст модели.
 * Слова берутся у самих ворот: копия здесь осталась бы зелёной, изменись их
 * формат, и продолжала бы называть себя проверкой ворот.
 */
const assemblyGate = () =>
  new CanonicalPrepareBlockedError(
    "ASSEMBLY_QA_FAILED",
    `качество сборки: ${blockingIssues({
      quoteDefectSlides: new Set(),
      codeSlides: new Set(),
      repeatedTextSlides: new Set(["p13_ru_wikipedia"]),
    }).join("; ")}`
  );

/** Гейт аналитики: приезжает обычной ошибкой, кодом `CANONICAL_PREPARE_FAILED`. */
const analyticsGate = () => new Error("prepare gate failed: MATERIAL_THEME_COVERAGE=87.5");

/** Подводка Arsenkin неполна — прогон помечен об этом при сборе. */
const LINKAGE_INCOMPLETE = ["arsenkin-skipped:no-base"];

beforeAll(async () => {
  const seed = await seedPreparedRun(CASE);
  jobId = seed.unifiedJobId;
  composite = seed.compositeDatasetId;
});

afterAll(() => {
  rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
});

/**
 * Прогон, дошедший до подготовки и упавший на ней.
 *
 * Чекпоинт `ASSEMBLY` ставится намеренно: на настоящем первом отказе его нет
 * (`ASSEMBLY` выводит только `failRetryable`, а этот путь его больше не зовёт),
 * и проверять нужно ровно то, что терминальный патч **не стирает того, что
 * было**.
 */
async function failPrepareWith(
  err: unknown,
  over?: Partial<UnifiedCollectionJob>
): Promise<UnifiedCollectionJob> {
  return await failPrepare({
    caseId: CASE,
    compositeDatasetId: composite,
    error: err,
    now: NOW,
    job: { resumeCheckpoint: "ASSEMBLY", warnings: [], ...over },
  });
}

const stepsAfter = (job: UnifiedCollectionJob) => stepsAfterPrepare(job, NOW);

const recoveryFor = async (job: UnifiedCollectionJob, rows: WorkflowStepRow[]) => {
  pipeline.rows = rows;
  return await evaluateUnifiedCollectionRecoveryEligibility({ caseId: CASE, job, now: NOW });
};

describe("детерминированный отказ подготовки", () => {
  it("останавливает прогон терминально с первой попытки", async () => {
    const job = await failPrepareWith(overBudget());

    expect(job.stage).toBe("FAILED_TERMINAL");
    expect(job.status).toBe("FAILED");
    expect(job.lastErrorCode).toBe("ASSEMBLY_QA_FAILED");
    // Признак того, что `failRetryable` не вызывался: пометку ставит он.
    expect(job.warnings).not.toContain("retryable-assembly-failure");
    expect(job.warnings).toContain("CANONICAL_PREPARE_BLOCKED");
  });

  it("не стирает того, что на джобе было, и доносит маркер гейта", async () => {
    const job = await failPrepareWith(overBudget());

    expect(job.resumeCheckpoint).toBe("ASSEMBLY");
    // Кнопки считают из строки джобы — маркер обязан доехать именно сюда.
    expect(job.lastError).toContain("NARRATIVE_OVER_BUDGET=");
    expect(job.lastError).toContain("p13_ru_wikipedia");
  });

  it("на настоящем первом отказе чекпоинта нет вовсе", async () => {
    // `ASSEMBLY` выставляет только `failRetryable`, а его этот путь не зовёт:
    // сохранять на первом отказе нечего, и требовать обратное — выдумывать
    // состояние. Читателей у чекпоинта на терминальной джобе нет.
    const job = await failPrepareWith(overBudget(), { resumeCheckpoint: null });

    expect(job.stage).toBe("FAILED_TERMINAL");
    expect(job.resumeCheckpoint ?? null).toBeNull();
  });

  it("повторного захода конвейеру не назначает", async () => {
    // Цена вопроса — оплаченные стадии GPT: у шага десять попыток, и каждая
    // из них зовёт модель заново.
    const steps = stepsAfter(await failPrepareWith(overBudget()));
    const prepare = steps[steps.length - 1]!;

    expect(prepare.state).toBe("FAILED");
    expect(prepare.attempts).toBe(1);
    expect(prepare.nextRunAt).toBeNull();
    // И панель продолжения не обещает.
    expect(autoResumeState(steps, NOW).pending).toBe(false);
  });

  it("потеря резака абзацев останавливает так же", async () => {
    const job = await failPrepareWith(reflowLoss());

    expect(job.stage).toBe("FAILED_TERMINAL");
    expect(job.lastError).toContain("NARRATIVE_REFLOW_LOSS=");
    expect(job.warnings).not.toContain("retryable-assembly-failure");
  });

  it("потеря разбивки абзаца останавливает так же", async () => {
    // Третий отказ той же природы: те же паки — та же раскладка — та же
    // потеря. Повтор её не лечит, а стоит четырёх стадий модели.
    const job = await failPrepareWith(splitLoss());

    expect(job.stage).toBe("FAILED_TERMINAL");
    expect(job.lastError).toContain("NARRATIVE_SPLIT_LOSS=");
    expect(job.warnings).not.toContain("retryable-assembly-failure");
  });

  it("кнопка восстановления закрыта: она запустила бы ту же подготовку", async () => {
    const job = await failPrepareWith(overBudget());

    const elig = await recoveryFor(job, stepsAfter(job));

    expect(elig.recoveryAllowed).toBe(false);
    expect(elig.recoveryBlockerReason).toBe("PREPARE_GATE_NOT_FIXED_BY_RETRY");
  });

  it("у прогона без конвейера шагов ответ тот же", async () => {
    // Прежняя эвристика отвечает прогонам, созданным до конвейера, и ветка
    // `ASSEMBLY_RESUME` стоит в ней **раньше** проверки гейта. Она запускает ту
    // же подготовку, что и упала, поэтому перехватить этот отказ не должна.
    const job = await failPrepareWith(overBudget());
    pipeline.rows = [];

    const elig = await evaluateUnifiedCollectionRecoveryEligibility({
      caseId: CASE,
      job,
      manifest: {
        version: "base-collection-manifest-v1",
        unifiedJobId: jobId,
        caseId: CASE,
        capturedAt: NOW.toISOString(),
        baseReportRunId: "base-run",
        searchResultIds: ["sr-1"],
        searchSurfaceItemIds: ["si-1"],
        baseCount: 2,
        actualProviders: [],
        realCollectionSufficient: true,
      },
      now: NOW,
    });

    expect(elig.recoveryReason).not.toBe("ASSEMBLY_RESUME");
    expect(elig.recoveryBlockerReason).toBe("PREPARE_GATE_NOT_FIXED_BY_RETRY");
  });

  it("пересобрать отчёт при этом можно", async () => {
    const job = await failPrepareWith(overBudget());
    pipeline.rows = stepsAfter(job);

    const elig = await evaluateUnifiedReportRebuildEligibility({ caseId: CASE, job, now: NOW });

    expect(elig.rebuildBlockerReason).toBeNull();
    expect(elig.rebuildAllowed).toBe(true);
  });
});

describe("сторож восстановления спрашивает, какой шаг возобновляется", () => {
  it("на шаге, отличном от подготовки, не срабатывает", async () => {
    // «Та же подготовка» — это про `REPORT_PREPARE`. Подводка Arsenkin,
    // случись ей быть планом, **подводит оплаченные наблюдения**, а не
    // повторяет упавшую сборку: закрыть её этим сторожем значит отнять у
    // прогона путь к уже оплаченной работе.
    const job = await failPrepareWith(overBudget());
    const rows = stepsAfter(job);
    const arsenkin = {
      ...rows[1]!,
      state: "FAILED",
      attempts: 1,
      nextRunAt: null,
      lastError: job.lastError,
      lastErrorCode: job.lastErrorCode,
    } as WorkflowStepRow;

    const elig = await recoveryFor(job, [rows[0]!, arsenkin, rows[2]!, rows[3]!]);

    expect(elig.recoveryBlockerReason).not.toBe("PREPARE_GATE_NOT_FIXED_BY_RETRY");
    expect(elig.recoveryReason).toBe("ARSENKIN_INGEST_RESUME");
  });

  it("на планах, отличных от возобновления, не срабатывает", async () => {
    // Сторож отвечает на «повторять ли», а не на «где мы»: завершённому и
    // идущему прогону он ответа не должен подменять.
    const job = await failPrepareWith(overBudget());
    const rows = stepsAfter(job);
    const done = { ...rows[3]!, state: "DONE", nextRunAt: null } as WorkflowStepRow;
    const exhausted = { ...rows[3]!, attempts: 10, maxAttempts: 10 } as WorkflowStepRow;

    const completed = await recoveryFor(job, [rows[0]!, rows[1]!, rows[2]!, done]);
    const spent = await recoveryFor(job, [rows[0]!, rows[1]!, rows[2]!, exhausted]);

    expect(completed.recoveryBlockerReason).toBe("JOB_ALREADY_COMPLETED");
    expect(spent.recoveryBlockerReason).toBe("STEP_ATTEMPTS_EXHAUSTED");
  });
});

describe("отказ ворот сборки с тем же кодом", () => {
  it("остаётся возобновляемым: ворота читают текст модели", async () => {
    const job = await failPrepareWith(assemblyGate());

    expect(job.stage).toBe("FAILED_RETRYABLE");
    expect(job.lastErrorCode).toBe("ASSEMBLY_QA_FAILED");
    expect(job.resumeCheckpoint).toBe("ASSEMBLY");
    expect(job.warnings).toContain("retryable-assembly-failure");
    // Повтор назначен: у этих ворот он законен — часть их читает текст модели.
    const steps = stepsAfter(job);
    expect(steps[steps.length - 1]!.nextRunAt).not.toBeNull();
  });

  it("и кнопку восстановления не теряет", async () => {
    const job = await failPrepareWith(assemblyGate());

    const elig = await recoveryFor(job, stepsAfter(job));

    expect(elig.recoveryAllowed).toBe(true);
    expect(elig.recoveryBlockerReason).toBeNull();
  });

  it("отказ обязательной секции тоже остаётся возобновляемым", async () => {
    const job = await failPrepareWith(
      new CanonicalPrepareBlockedError("REQUIRED_SECTION_FAILED", "required sections failed: p07")
    );

    expect(job.stage).toBe("FAILED_RETRYABLE");
    expect(job.warnings).toContain("retryable-assembly-failure");
  });
});

/*
 * Вторая возобновляемая ветка — неполная подводка Arsenkin. Признак стоит и на
 * ней, и объём правки шире одного отказа: истинен он для любого имени из
 * `DETERMINISTIC_GATES`. Обе стороны закреплены здесь — иначе половину правки
 * можно снять, оставив весь набор зелёным.
 */
describe("неполная подводка Arsenkin", () => {
  it("прежний гейт аналитики становится терминальным и на ней", async () => {
    // До правки один и тот же `MATERIAL_THEME_COVERAGE` был терминальным при
    // целой подводке и получал десять кругов при неполной — два ответа на один
    // вопрос. Повтор ничего не подводит: он гоняет подготовку над тем же
    // составным набором.
    const job = await failPrepareWith(analyticsGate(), { warnings: LINKAGE_INCOMPLETE });

    expect(job.stage).toBe("FAILED_TERMINAL");
    expect(job.lastErrorCode).toBe("CANONICAL_PREPARE_FAILED");
    expect(job.warnings).not.toContain("retryable-linkage-failure");
  });

  it("отказ, который гейтом не является, по-прежнему возобновляем", async () => {
    // Обязательная половина: без неё сторож можно снять со всей ветки молча.
    const job = await failPrepareWith(assemblyGate(), { warnings: LINKAGE_INCOMPLETE });

    expect(job.stage).toBe("FAILED_RETRYABLE");
    expect(job.lastErrorCode).toBe("ASSEMBLY_INCOMPLETE_ENRICHMENT");
    expect(job.warnings).toContain("retryable-linkage-failure");
  });

  it("на гейте код отказа подменяется — и это названо, а не обнаружено потом", async () => {
    // `ASSEMBLY_INCOMPLETE_ENRICHMENT` — единственный сигнал оператору «причина
    // в обогащении, а не в деке», и на детерминированном отказе он исчезает.
    // Компенсация — причина, названная словами (`prepareGateAdvice`).
    const job = await failPrepareWith(overBudget(), { warnings: LINKAGE_INCOMPLETE });

    expect(job.stage).toBe("FAILED_TERMINAL");
    expect(job.lastErrorCode).toBe("ASSEMBLY_QA_FAILED");
    expect(job.lastErrorCode).not.toBe("ASSEMBLY_INCOMPLETE_ENRICHMENT");
  });
});
