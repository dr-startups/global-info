import { describe, expect, it } from "vitest";
import { planResumeFromSteps } from "../../src/modules/digital-profile/workflow/resume-plan";
import { UNIFIED_PIPELINE } from "../../src/modules/digital-profile/workflow/step-plan";
import type { WorkflowStepRow } from "../../src/modules/digital-profile/workflow/step-types";

/**
 * Шаг 12.4 плана.
 *
 * «Где мы остановились» выводилось эвристиками из шести полей джобы, и там
 * жили дефекты: состояние «пять прогонов зарегистрировано, задач две»
 * проходило проверку `enrichmentCount >= 5`, и восстановление уходило
 * опрашивать несуществующие задачи до исчерпания бюджета.
 */

const NOW = new Date("2026-07-25T12:00:00.000Z");

function pipeline(over: Record<string, Partial<WorkflowStepRow>> = {}): WorkflowStepRow[] {
  return UNIFIED_PIPELINE.map((d) => ({
    id: `s-${d.name}`,
    caseId: "case-1",
    jobId: "job-1",
    name: d.name,
    position: d.position,
    state: "PENDING",
    attempts: 0,
    maxAttempts: d.maxAttempts ?? 40,
    nextRunAt: null,
    leaseOwner: null,
    leaseUntil: null,
    inputHash: null,
    outputRef: null,
    lastError: null,
    lastErrorCode: null,
    ...(over[d.name] ?? {}),
  })) as WorkflowStepRow[];
}

describe("план возобновления выводится из шагов", () => {
  it("упавший шаг подлежит возобновлению и пробуждению", () => {
    const plan = planResumeFromSteps(
      pipeline({
        BASE_COLLECTION: { state: "DONE" },
        ARSENKIN_ENRICHMENT: { state: "FAILED", attempts: 3 },
      }),
      NOW
    );
    expect(plan).toEqual({
      kind: "resume",
      stepName: "ARSENKIN_ENRICHMENT",
      reason: "ARSENKIN_INGEST_RESUME",
      requeue: true,
    });
  });

  it("причина возобновления соответствует месту остановки", () => {
    const at = (name: string) =>
      planResumeFromSteps(
        pipeline(
          Object.fromEntries(
            UNIFIED_PIPELINE.filter((d) => d.position < (UNIFIED_PIPELINE.find((x) => x.name === name)?.position ?? 0))
              .map((d) => [d.name, { state: "DONE" as const }])
              .concat([[name, { state: "FAILED" as const, attempts: 1 }]] as never)
          )
        ),
        NOW
      );
    expect(at("BASE_COLLECTION")).toMatchObject({ reason: "BASE_RESUME" });
    expect(at("COMPOSITE_MERGE")).toMatchObject({ reason: "ASSEMBLY_RESUME" });
    expect(at("REPORT_PREPARE")).toMatchObject({ reason: "RENDER_RESUME" });
  });

  it("исчерпанный бюджет попыток — не «нажмите ещё раз»", () => {
    const plan = planResumeFromSteps(
      pipeline({
        BASE_COLLECTION: { state: "DONE" },
        ARSENKIN_ENRICHMENT: { state: "FAILED", attempts: 40, maxAttempts: 40 },
      }),
      NOW
    );
    expect(plan.kind).toBe("exhausted");
  });

  it("шаг под живой лизой — работа идёт, вмешиваться нечего", () => {
    const plan = planResumeFromSteps(
      pipeline({
        BASE_COLLECTION: { state: "RUNNING", leaseUntil: new Date(NOW.getTime() + 60_000) },
      }),
      NOW
    );
    expect(plan).toEqual({ kind: "in_progress", stepName: "BASE_COLLECTION" });
  });

  it("шаг, ждущий своего времени, будить не нужно", () => {
    // Иначе восстановление участило бы опрос провайдера — ровно то
    // приглашение вмешаться в здоровый прогон, что чинилось в 11.1-bis.
    const plan = planResumeFromSteps(
      pipeline({
        BASE_COLLECTION: { state: "DONE" },
        ARSENKIN_ENRICHMENT: { state: "WAITING", nextRunAt: new Date(NOW.getTime() + 10_000) },
      }),
      NOW
    );
    expect(plan.kind).toBe("in_progress");
  });

  it("просроченный шаг подбирается без пробуждения — расписание уже в силе", () => {
    const plan = planResumeFromSteps(
      pipeline({
        BASE_COLLECTION: { state: "DONE" },
        ARSENKIN_ENRICHMENT: { state: "WAITING", nextRunAt: new Date(NOW.getTime() - 1_000) },
      }),
      NOW
    );
    expect(plan).toMatchObject({ kind: "resume", requeue: false });
  });

  it("шаг без расписания требует пробуждения", () => {
    // Так выглядит потерянная работа: шаг готов, но его никто не разбудит.
    const plan = planResumeFromSteps(pipeline({ BASE_COLLECTION: { state: "PENDING", nextRunAt: null } }), NOW);
    expect(plan).toMatchObject({ kind: "resume", requeue: true, stepName: "BASE_COLLECTION" });
  });

  it("завершённый конвейер восстанавливать нечего", () => {
    const all = Object.fromEntries(UNIFIED_PIPELINE.map((d) => [d.name, { state: "DONE" as const }]));
    expect(planResumeFromSteps(pipeline(all), NOW)).toEqual({ kind: "completed" });
  });

  it("пропущенные шаги не считаются местом остановки", () => {
    const plan = planResumeFromSteps(
      pipeline({
        BASE_COLLECTION: { state: "DONE" },
        ARSENKIN_ENRICHMENT: { state: "SKIPPED" },
        COMPOSITE_MERGE: { state: "FAILED", attempts: 1 },
      }),
      NOW
    );
    expect(plan).toMatchObject({ stepName: "COMPOSITE_MERGE" });
  });

  it("прогон без шагов не выдаёт себя за восстановимый", () => {
    // Старые прогоны созданы до шага 12; для них остаётся прежний путь.
    expect(planResumeFromSteps([], NOW)).toEqual({ kind: "completed" });
  });
});
