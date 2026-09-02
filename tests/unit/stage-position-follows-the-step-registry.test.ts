import { describe, expect, it, vi } from "vitest";
import {
  outcomeFromJob,
  unifiedStepHandlers,
} from "@/modules/digital-profile/workflow/unified-step-handlers";
import { nextRunnableStep } from "@/modules/digital-profile/workflow/step-plan";
import type { StepDefinition, WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

/**
 * «Джоба переросла шаг» — сравнение двух позиций, и обе обязаны читаться из
 * реестра.
 *
 * Пока позиция стадии `CLIENT_CONTENT` была записана числом, пара держалась на
 * совпадении: вставь шаг раньше `REPORT_PREPARE` — и шаг подготовки станет
 * пятым, а `CLIENT_CONTENT` останется четвёртым. Сравнение станет ложным для
 * шага, который джоба давно прошла, и это **не отказ, а зависание**: шаг
 * никогда не признаётся сделанным и ждёт до исчерпания `maxWaitMs`, а
 * проснувшись — платит за второй прогон подготовки.
 *
 * Проверить это можно только реестром со вставленным шагом: на нынешнем
 * реестре число совпадает, и любой тест по сегодняшним величинам зелен при
 * обеих реализациях.
 */

/**
 * Реестр со вставленным вторым шагом: `REPORT_PREPARE` уезжает на пятую
 * позицию. Через `vi.hoisted`, потому что подмену модуля vitest поднимает выше
 * объявлений.
 */
const { SHIFTED } = vi.hoisted(() => ({
  SHIFTED: [
    { name: "BASE_COLLECTION", position: 1, stage: "BASE_COLLECTION", maxAttempts: 10 },
    { name: "SANCTIONS_SWEEP", position: 2, stage: "SANCTIONS_SWEEP", maxAttempts: 10 },
    { name: "ARSENKIN_ENRICHMENT", position: 3, stage: "ARSENKIN_ENRICHMENT", maxAttempts: 10 },
    { name: "COMPOSITE_MERGE", position: 4, stage: "COMPOSITE_MERGE", maxAttempts: 10 },
    { name: "REPORT_PREPARE", position: 5, stage: "ORION_PREPARE", maxAttempts: 10 },
  ] as StepDefinition[],
}));

/*
 * `stepDefinition` подменяется вместе с реестром: оригинал замкнут на настоящий
 * `UNIFIED_PIPELINE`, и без подмены половины пары читали бы разные реестры —
 * тест доказывал бы не то. Тело то же самое, поиск по имени.
 */
vi.mock("@/modules/digital-profile/workflow/step-plan", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  UNIFIED_PIPELINE: SHIFTED,
  stepDefinition: (name: string) => SHIFTED.find((d) => d.name === name) ?? null,
}));

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

const NOW = new Date("2026-08-29T12:00:00.000Z");

function step(name: string, over: Partial<WorkflowStepRow> = {}): WorkflowStepRow {
  return {
    id: `s-${name}`,
    caseId: "case-1",
    jobId: "job-1",
    name,
    position: SHIFTED.find((d) => d.name === name)?.position ?? 0,
    state: "RUNNING",
    attempts: 0,
    maxAttempts: 10,
    nextRunAt: null,
    leaseOwner: "w",
    leaseUntil: null,
    inputHash: null,
    outputRef: null,
    lastError: null,
    lastErrorCode: null,
    ...over,
  };
}

function job(stage: string): UnifiedCollectionJob {
  return {
    caseId: "case-1",
    jobId: "job-1",
    unifiedJobId: "job-1",
    stage,
    status: "RUNNING",
    cancelRequested: false,
    warnings: [],
    lastError: null,
    lastErrorCode: null,
    compositeDatasetId: "ds-1",
    baseReportRunId: "base-1",
  } as unknown as UnifiedCollectionJob;
}

describe("позиция стадии джобы после вставки шага в реестр", () => {
  it("шаг, который джоба переросла, признаётся сделанным", () => {
    // Джоба пишет клиентский контент — это внутри подготовки отчёта, то есть
    // слияние она прошла. Пятёрка у подготовки, четвёрка у слияния: вердикт
    // обязан следовать за реестром, а не за записанным числом.
    const ahead = job("CLIENT_CONTENT");
    const out = outcomeFromJob(step("COMPOSITE_MERGE"), ahead, ahead, NOW);
    expect(out.kind).toBe("done");
  });

  it("перерощенный шаг не запускает платный тик второй раз", async () => {
    tick.mockClear();
    loadJob.mockResolvedValue(job("CLIENT_CONTENT"));
    const outcome = await unifiedStepHandlers()["COMPOSITE_MERGE"]!(step("COMPOSITE_MERGE"));
    expect(tick).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("done");
  });

  it("внутренняя стадия не закрывает шаг, которому принадлежит", () => {
    // `CLIENT_CONTENT` делит позицию с `ORION_PREPARE`: движение внутри одного
    // шага завершением не является — иначе подготовка закрывалась бы на
    // середине.
    const here = job("CLIENT_CONTENT");
    const out = outcomeFromJob(step("REPORT_PREPARE"), here, here, NOW);
    expect(out.kind).toBe("waiting");
  });

  it("стадия, которой в реестре нет, конвейер вперёд не двигает", () => {
    const alien = job("SOMETHING_ELSE");
    const out = outcomeFromJob(step("BASE_COLLECTION"), alien, alien, NOW);
    expect(out.kind).toBe("waiting");
  });

  it("прогон со старым набором позиций доигрывается по своим строкам", () => {
    // Строки созданы до вставки шага: у них своя нумерация и нет строки нового
    // шага. Порядок исполнения берётся из них же, а не из реестра.
    const old = [
      step("BASE_COLLECTION", { position: 1, state: "DONE" }),
      step("ARSENKIN_ENRICHMENT", { position: 2, state: "DONE" }),
      step("COMPOSITE_MERGE", { position: 3, state: "PENDING", nextRunAt: NOW }),
      step("REPORT_PREPARE", { position: 4, state: "PENDING" }),
    ];
    expect(nextRunnableStep(old, NOW)?.name).toBe("COMPOSITE_MERGE");
  });
});
