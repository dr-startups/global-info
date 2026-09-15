import { describe, expect, it } from "vitest";
import {
  LIGHT_PIPELINE,
  UNIFIED_PIPELINE,
  deriveJobStage,
  pipelineFor,
  stepDefinition,
} from "@/modules/digital-profile/workflow/step-plan";
import { ensurePipelineSteps } from "@/modules/digital-profile/workflow/step-store";
import { detectStageDrift } from "@/modules/digital-profile/workflow/stage-reconciliation";
import {
  outcomeForStoppedJob,
  outcomeFromJob,
  unifiedStepHandlers,
} from "@/modules/digital-profile/workflow/unified-step-handlers";
import type { WorkflowStepRow } from "@/modules/digital-profile/workflow/step-types";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

/**
 * Лёгкий прогон — два шага, и кончается он своей стадией.
 *
 * Посетитель сайта получает вердикт, а не отчёт: после базового сбора нет ни
 * обогащения, ни слияния, ни подготовки. Кончайся лёгкая джоба `REPORT_READY`,
 * админка обещала бы отчёт, которого нет, а шаги и стадия отвечали бы на
 * вопрос «где прогон» по-разному.
 */

const NOW = new Date("2026-09-15T12:00:00.000Z");

function row(name: string, state: WorkflowStepRow["state"] = "DONE"): WorkflowStepRow {
  return {
    id: `s-${name}`,
    caseId: "case-1",
    jobId: "job-1",
    name,
    position: stepDefinition(name)?.position ?? 0,
    state,
    attempts: 0,
    maxAttempts: 10,
    nextRunAt: null,
    leaseOwner: null,
    leaseUntil: null,
    inputHash: null,
    outputRef: null,
    lastError: null,
    lastErrorCode: null,
  };
}

function job(over: Record<string, unknown>): UnifiedCollectionJob {
  return {
    caseId: "case-1",
    jobId: "job-1",
    unifiedJobId: "job-1",
    stage: "BASE_COLLECTION",
    status: "RUNNING",
    cancelRequested: false,
    warnings: [],
    lastError: null,
    lastErrorCode: null,
    compositeDatasetId: null,
    baseReportRunId: "base-1",
    ...over,
  } as unknown as UnifiedCollectionJob;
}

function fakeSteps() {
  const created: Array<Record<string, unknown>> = [];
  const prisma = {
    workflowStep: {
      createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
        created.push(...data);
        return { count: data.length };
      },
      findMany: async () => [],
    },
  };
  return { created, prisma: prisma as never };
}

describe("план лёгкого прогона", () => {
  it("два шага: базовый сбор, затем вердикт", () => {
    expect(LIGHT_PIPELINE.map((d) => [d.name, d.position, d.stage])).toEqual([
      ["BASE_COLLECTION", 1, "BASE_COLLECTION"],
      ["LIGHT_VERDICT", 2, "LIGHT_VERDICT"],
    ]);
  });

  it("базовый сбор — та же запись реестра, что у полного конвейера, а не копия", () => {
    // Копия разошлась бы с оригиналом по бюджетам при первой же правке, и
    // `stepDefinition` по имени отдавал бы одну из двух.
    expect(LIGHT_PIPELINE[0]).toBe(UNIFIED_PIPELINE[0]);
  });

  it("режим выбирает план, а полный план остался прежним", () => {
    expect(pipelineFor("full")).toBe(UNIFIED_PIPELINE);
    expect(pipelineFor("light")).toBe(LIGHT_PIPELINE);
    expect(UNIFIED_PIPELINE.map((d) => d.name)).toEqual([
      "BASE_COLLECTION",
      "ARSENKIN_ENRICHMENT",
      "COMPOSITE_MERGE",
      "REPORT_PREPARE",
    ]);
  });

  it("определение шага находится в обоих планах, и у имени одна запись", () => {
    expect(stepDefinition("LIGHT_VERDICT")?.stage).toBe("LIGHT_VERDICT");
    expect(stepDefinition("ARSENKIN_ENRICHMENT")?.position).toBe(2);
    const byName = new Map<string, unknown>();
    for (const def of [...UNIFIED_PIPELINE, ...LIGHT_PIPELINE]) {
      const seen = byName.get(def.name);
      expect(seen === undefined || seen === def, def.name).toBe(true);
      byName.set(def.name, def);
    }
  });
});

describe("стадия лёгкого прогона выводится из шагов", () => {
  it("оба шага сделаны — LIGHT_READY, а не REPORT_READY", () => {
    expect(deriveJobStage([row("BASE_COLLECTION"), row("LIGHT_VERDICT")])).toEqual({
      stage: "LIGHT_READY",
      status: "COMPLETED",
      progress: 1,
    });
  });

  it("полный конвейер по-прежнему кончается REPORT_READY", () => {
    const steps = ["BASE_COLLECTION", "ARSENKIN_ENRICHMENT", "COMPOSITE_MERGE", "REPORT_PREPARE"].map(
      (name) => row(name)
    );
    expect(deriveJobStage(steps).stage).toBe("REPORT_READY");
  });

  it("сбор готов, вердикт ждёт — стадия LIGHT_VERDICT, половина пути", () => {
    expect(deriveJobStage([row("BASE_COLLECTION"), row("LIGHT_VERDICT", "PENDING")])).toEqual({
      stage: "LIGHT_VERDICT",
      status: "WAITING",
      progress: 0.5,
    });
  });

  it("сверка не видит расхождения у готовой лёгкой джобы", () => {
    expect(detectStageDrift("LIGHT_READY", [row("BASE_COLLECTION"), row("LIGHT_VERDICT")], "full")).toBeNull();
  });
});

describe("шаги материализуются по режиму", () => {
  it("лёгкий режим заводит два шага, готов к исполнению только первый", async () => {
    const { created, prisma } = fakeSteps();
    await ensurePipelineSteps({ caseId: "case-1", jobId: "job-1", mode: "light", now: NOW, prisma });
    expect(created.map((r) => [r.name, r.position, r.nextRunAt])).toEqual([
      ["BASE_COLLECTION", 1, NOW],
      ["LIGHT_VERDICT", 2, null],
    ]);
  });

  it("без режима — полный конвейер из четырёх шагов, как из админки", async () => {
    const { created, prisma } = fakeSteps();
    await ensurePipelineSteps({ caseId: "case-1", jobId: "job-1", now: NOW, prisma });
    expect(created.map((r) => r.name)).toEqual([
      "BASE_COLLECTION",
      "ARSENKIN_ENRICHMENT",
      "COMPOSITE_MERGE",
      "REPORT_PREPARE",
    ]);
  });
});

describe("обработчики шагов лёгкого прогона", () => {
  it("у шага вердикта есть обработчик: без него воркер уронил бы шаг STEP_HANDLER_MISSING", () => {
    expect(typeof unifiedStepHandlers().LIGHT_VERDICT).toBe("function");
  });

  it("готовая лёгкая джоба — шаг сделан, а не ожидание", () => {
    const ready = job({ stage: "LIGHT_READY", status: "COMPLETED", mode: "light" });
    expect(outcomeForStoppedJob(ready)?.kind).toBe("done");
  });

  it("базовый сбор лёгкой джобы сделан, когда джоба ушла на вердикт", () => {
    const verdict = job({ stage: "LIGHT_VERDICT", mode: "light" });
    expect(outcomeFromJob(row("BASE_COLLECTION", "RUNNING"), verdict, verdict, NOW).kind).toBe("done");
  });

  it("стадия полного конвейера базовый сбор лёгкой джобы не закрывает", () => {
    // Позиция стадии читается из плана режима джобы: в лёгком плане обогащения
    // нет, и признать по нему сбор сделанным значило бы разбудить шаг вердикта
    // на джобе, ушедшей не туда.
    const alien = job({ stage: "ARSENKIN_ENRICHMENT", mode: "light" });
    expect(outcomeFromJob(row("BASE_COLLECTION", "RUNNING"), alien, alien, NOW).kind).toBe("waiting");
  });
});
