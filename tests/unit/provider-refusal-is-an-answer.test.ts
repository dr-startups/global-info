/**
 * Отказ провайдера по тарифу или ключу — это ответ, а не сбой.
 *
 * QA MVP 14.09.2026: пять прогонов встали на `ARSENKIN_ENRICHMENT_FAILED`,
 * потому что Arsenkin отвечал на подачу HTTP 403
 * `{"code":"TO_LOW_SUBSRIPTION","msg":"Ваш тарифный план не имеет доступа к API!"}`.
 * Отказ считался обычным `FAILED`, тик блокировал конвейер «повторяемым»
 * отказом, авто-возобновление билось об него каждые пять минут до последней
 * попытки — и отчёта не было вовсе при оплаченном базовом сборе и собранном
 * Topvisor.
 *
 * Правило продукта: источник не дал данных — страница говорит об этом словами и
 * называет причину. Отказ в доступе — исход агента `REFUSED`: завершён, не
 * упал; его поверхности получают ячейку «ошибка: провайдер отказал в доступе»;
 * прогон идёт дальше.
 */

import { describe, expect, it } from "vitest";
import {
  disabledSurfaceCoverageCells,
  surfaceCoverageFromEnrichmentState,
  type ArsenkinAgentProgress,
  type ArsenkinEnrichmentState,
} from "@/modules/digital-profile/services/arsenkin-enrichment-state";
import {
  runDurableArsenkinEnrichmentTick,
  type EnrichmentPollTaskSnap,
} from "@/modules/digital-profile/services/arsenkin-enrichment-tick";
import { resolveEmptySurfaceCollection } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

const CASE = "case-refused";
const JOB = "job-refused";
const runId = (agent: string) => `unified-${JOB}-${agent}`;

function job(): UnifiedCollectionJob {
  const now = new Date().toISOString();
  return {
    version: "unified-orion-collection-job-v1",
    caseId: CASE,
    jobId: JOB,
    unifiedJobId: JOB,
    stage: "ARSENKIN_ENRICHMENT",
    status: "WAITING",
    progress: 0.35,
    versionNum: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    requestedBy: "test",
    arsenkinMode: "full-first36",
    baseReportRunId: "base-run-1",
    arsenkinReportRunId: runId("ARSENKIN_SUGGESTIONS_REAL"),
    enrichmentRunIds: [runId("ARSENKIN_SEARCH_TOP_REAL"), runId("ARSENKIN_SUGGESTIONS_REAL"), runId("ARSENKIN_PAA_REAL")],
    warnings: [],
    pollAttempt: 0,
  } as unknown as UnifiedCollectionJob;
}

/** Наблюдено 14.09.2026: подача отклонена по тарифу. */
const REFUSAL = {
  _submitDiagnostics: {
    code: "TO_LOW_SUBSRIPTION",
    message: 'Arsenkin HTTP 403: {"code":"TO_LOW_SUBSRIPTION","msg":"Ваш тарифный план не имеет доступа к API!"}',
    httpStatus: 403,
  },
};

/** Выдача отработала и вернула пустой, но корректный ответ — как в тесте выключенного инструмента. */
const SEARCH_TOP_DONE: EnrichmentPollTaskSnap = {
  id: "pt-top",
  reportRunId: runId("ARSENKIN_SEARCH_TOP_REAL"),
  externalTaskId: "ext-top",
  toolName: "check-top",
  state: "DONE",
  responseJson: { code: "ok", task_id: "ext-top", result: { tops: [] } },
  requestJson: { tools_name: "check-top", data: { queries: ["субъект"] } },
};

function failedTasks(diagnostics: unknown, errorCode: string): EnrichmentPollTaskSnap[] {
  return [SEARCH_TOP_DONE].concat((
    [
      ["ARSENKIN_SUGGESTIONS_REAL", "suggest", "a"],
      ["ARSENKIN_SUGGESTIONS_REAL", "suggest", "b"],
      ["ARSENKIN_PAA_REAL", "paa", "c"],
      ["ARSENKIN_PAA_REAL", "paa", "d"],
    ] as const
  ).map(([agent, tool, suffix]) => ({
    id: `pt-${suffix}`,
    reportRunId: runId(agent),
    externalTaskId: null,
    toolName: tool,
    state: "FAILED",
    errorCode,
    responseJson: diagnostics,
    requestJson: { tools_name: tool, data: { queries: ["субъект"] } },
  })) as EnrichmentPollTaskSnap[]);
}

describe("отказ Arsenkin по тарифу", () => {
  it("исход агента — REFUSED: завершён, конвейер не заблокирован", async () => {
    const result = await runDurableArsenkinEnrichmentTick({
      job: job(),
      listProviderTasks: async () => failedTasks(REFUSAL, "http_403"),
      pollTask: async (t) => t,
    });
    for (const name of ["ARSENKIN_SUGGESTIONS_REAL", "ARSENKIN_PAA_REAL"]) {
      const a = result.state.agents.find((x) => x.agentName === name);
      expect(a?.terminalKind, name).toBe("REFUSED");
      expect(a?.terminal).toBe(true);
      expect(a?.ingested).toBe(true);
      expect(a?.errorCode).toBe("ARSENKIN_PROVIDER_REFUSED");
    }
    expect(result.state.failedAgents).toEqual([]);
    expect(result.state.enrichmentComplete).toBe(true);
    expect(result.blockPipeline).toBe(false);
    expect(result.warnings.join(" ")).toContain("arsenkin-provider-refused:ARSENKIN_SUGGESTIONS_REAL:TO_LOW_SUBSRIPTION");
  });

  it("прочий отказ задачи остаётся FAILED и блокирует, как прежде", async () => {
    const result = await runDurableArsenkinEnrichmentTick({
      job: job(),
      listProviderTasks: async () => failedTasks({ _submitDiagnostics: { code: "SERVER_ERROR", message: "Arsenkin HTTP 500", httpStatus: 500 } }, "http_500"),
      pollTask: async (t) => t,
    });
    const a = result.state.agents.find((x) => x.agentName === "ARSENKIN_SUGGESTIONS_REAL");
    expect(a?.terminalKind).toBe("FAILED");
    expect(result.blockPipeline).toBe(true);
  });
});

function agent(over: Partial<ArsenkinAgentProgress>): ArsenkinAgentProgress {
  return {
    agentName: "ARSENKIN_SUGGESTIONS_REAL",
    enrichmentRunId: runId("ARSENKIN_SUGGESTIONS_REAL"),
    scheduled: true,
    terminal: true,
    terminalKind: "REFUSED",
    ingested: true,
    pendingTaskCount: 0,
    doneTaskCount: 0,
    submitUnknownCount: 0,
    observationCount: 0,
    errorCode: "ARSENKIN_PROVIDER_REFUSED",
    ...over,
  };
}

describe("отказавший агент в охвате и на странице", () => {
  it("даёт по своим поверхностям ячейку «ошибка: провайдер отказал»", () => {
    const cells = disabledSurfaceCoverageCells({ agents: [agent({})] });
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.status).toBe("ERROR");
      expect(c.errorCode).toBe("PROVIDER_REFUSED");
      expect(c.provider).toBe("arsenkin");
    }
  });

  it("в сводке охвата считается окончательным отказом, а не повторяемым", () => {
    const state = {
      agents: [agent({})],
      pendingAgents: [],
      completedAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
      failedAgents: [],
      enrichmentObservationCount: 0,
    } as unknown as ArsenkinEnrichmentState;
    const cov = surfaceCoverageFromEnrichmentState(state);
    expect(cov.failedFinal).toBe(1);
    expect(cov.failedRetryable).toBe(0);
  });

  it("страница называет причину: провайдер отказал в доступе", () => {
    const status = resolveEmptySurfaceCollection(
      {
        surfaceUnits: [],
        scope: { regions: ["RU"], surfaces: null, subjectMatch: null, findingIds: null },
        surfaceCollectionHints: [
          { surface: "autocomplete", region: "RU", engine: "GOOGLE", status: "ERROR", errorCode: "PROVIDER_REFUSED", provider: "arsenkin" },
        ],
      } as never,
      "autocomplete"
    );
    expect(status.kind).toBe("COLLECTION_FAILED");
    expect(status.reasonLabel ?? "").toMatch(/провайдер отказал в доступе/);
  });
});
