import { describe, expect, it } from "vitest";
import {
  agentWasDisabled,
  disabledSurfaceCoverageCells,
  surfaceCoverageFromEnrichmentState,
  type ArsenkinAgentProgress,
  type ArsenkinEnrichmentState,
} from "@/modules/digital-profile/services/arsenkin-enrichment-state";
import {
  offlineSyntheticCompleteTick,
  runDurableArsenkinEnrichmentTick,
  type EnrichmentPollTaskSnap,
} from "@/modules/digital-profile/services/arsenkin-enrichment-tick";
import { ARSENKIN_REAL_AGENT_NAMES } from "@/modules/digital-profile/agents/real/real-arsenkin-agents";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

/**
 * Шаг AL. Выключенный составом инструмент — не «проверено, пусто».
 *
 * На живом прогоне 76 агенты `ARSENKIN_AI_SEARCH_REAL` и `ARSENKIN_URL_AUDIT_REAL`
 * не создали ни одной задачи (второй стадии нет в составе), но получили тот же
 * `EMPTY_VALID`, что и настоящая пустота после проверки. Одно слово с двумя
 * смыслами — и счётчики, и страница отчёта утверждали выполненную проверку.
 */

const CASE = "case-al";
const JOB = "job-al";
const runId = (agent: string) => `unified-${JOB}-${agent}`;

function job(over: Partial<UnifiedCollectionJob> = {}): UnifiedCollectionJob {
  const now = new Date().toISOString();
  return {
    version: "unified-orion-collection-job-v1",
    caseId: CASE,
    jobId: JOB,
    unifiedJobId: JOB,
    stage: "ARSENKIN_ENRICHMENT",
    status: "WAITING",
    progress: 0.55,
    versionNum: 1,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    requestedBy: "test",
    arsenkinMode: "full-first36",
    baseReportRunId: "base-run-1",
    arsenkinReportRunId: runId("ARSENKIN_SEARCH_TOP_REAL"),
    enrichmentRunIds: [
      runId("ARSENKIN_SEARCH_TOP_REAL"),
      runId("ARSENKIN_SUGGESTIONS_REAL"),
      runId("ARSENKIN_PAA_REAL"),
    ],
    actualProviders: [],
    warnings: [],
    artifactPaths: {},
    reportLinks: {},
    cancelRequested: false,
    resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
    nextPollAt: now,
    pollAttempt: 0,
    ...over,
  } as UnifiedCollectionJob;
}

/** Три включённых агента отработали и вернули пустые, но корректные ответы. */
const STAGE_ONE_DONE: EnrichmentPollTaskSnap[] = (
  [
    ["ARSENKIN_SEARCH_TOP_REAL", "check-top", "tops"],
    ["ARSENKIN_SUGGESTIONS_REAL", "suggest", "suggestions"],
    ["ARSENKIN_PAA_REAL", "paa", "questions"],
  ] as const
).map(([agent, tool, arrayKey], i) => ({
  id: `pt-${i}`,
  reportRunId: runId(agent),
  externalTaskId: `ext-${i}`,
  toolName: tool,
  state: "DONE",
  responseJson: { code: "ok", task_id: `ext-${i}`, result: { [arrayKey]: [] } },
  requestJson: { tools_name: tool, data: { queries: ["субъект"] } },
}));

function agent(over: Partial<ArsenkinAgentProgress>): ArsenkinAgentProgress {
  return {
    agentName: "ARSENKIN_AI_SEARCH_REAL",
    enrichmentRunId: null,
    scheduled: true,
    terminal: true,
    terminalKind: "EMPTY_VALID",
    ingested: true,
    pendingTaskCount: 0,
    doneTaskCount: 0,
    submitUnknownCount: 0,
    observationCount: 0,
    ...over,
  };
}

/** Структурный слепок прогона 76: трое работали, двое выключены составом. */
function run76State(over: Partial<ArsenkinAgentProgress> = {}): ArsenkinEnrichmentState {
  return {
    agents: [
      agent({
        agentName: "ARSENKIN_SEARCH_TOP_REAL",
        enrichmentRunId: "orion-arsenkin-agent-search-top-1",
        terminalKind: "SUCCESS",
        doneTaskCount: 2,
        observationCount: 200,
      }),
      agent({
        agentName: "ARSENKIN_SUGGESTIONS_REAL",
        enrichmentRunId: "orion-arsenkin-agent-suggestions-1",
        terminalKind: "SUCCESS",
        doneTaskCount: 3,
        observationCount: 36,
      }),
      agent({
        agentName: "ARSENKIN_PAA_REAL",
        enrichmentRunId: "orion-arsenkin-agent-paa-1",
        terminalKind: "SUCCESS",
        doneTaskCount: 2,
        observationCount: 14,
      }),
      agent({ agentName: "ARSENKIN_AI_SEARCH_REAL", ...over }),
      agent({ agentName: "ARSENKIN_URL_AUDIT_REAL", ...over }),
    ],
  } as ArsenkinEnrichmentState;
}

describe("исход выключенного составом агента", () => {
  it("тик даёт DISABLED, а не пустоту после проверки", async () => {
    const result = await runDurableArsenkinEnrichmentTick({
      job: job(),
      listProviderTasks: async () => STAGE_ONE_DONE,
      pollTask: async (t) => t,
    });

    const ai = result.state.agents.find((a) => a.agentName === "ARSENKIN_AI_SEARCH_REAL");
    const audit = result.state.agents.find((a) => a.agentName === "ARSENKIN_URL_AUDIT_REAL");
    expect(ai?.terminalKind).toBe("DISABLED");
    expect(audit?.terminalKind).toBe("DISABLED");
    // Гейты завершения держатся на этих полях: выключенного не ждут.
    expect(ai?.ingested).toBe(true);
    expect(ai?.terminal).toBe(true);
    expect(result.state.enrichmentComplete).toBe(true);
    expect(result.warnings).toContain("arsenkin-agent-disabled-by-tools:ARSENKIN_AI_SEARCH_REAL");
  });

  it("оффлайн-контур по-прежнему закрывается EMPTY_VALID", async () => {
    const offline = await runDurableArsenkinEnrichmentTick({
      job: job({ enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map(runId) }),
      offlineEmptyValid: true,
      listProviderTasks: async () => [],
      pollTask: async (t) => t,
    });
    expect(offline.state.agents.map((a) => a.terminalKind)).toEqual(
      ARSENKIN_REAL_AGENT_NAMES.map(() => "EMPTY_VALID")
    );

    const synthetic = offlineSyntheticCompleteTick(job());
    expect(synthetic.state.agents.every((a) => a.terminalKind === "EMPTY_VALID")).toBe(true);
  });
});

describe("предикат «поверхность не спрашивали»", () => {
  it("истина для исхода DISABLED", () => {
    const state = run76State({ terminalKind: "DISABLED" });
    const ai = state.agents.find((a) => a.agentName === "ARSENKIN_AI_SEARCH_REAL")!;
    expect(agentWasDisabled(ai, state)).toBe(true);
  });

  it("истина для легаси-формы прогона, где остальные агенты работали", () => {
    const state = run76State();
    const ai = state.agents.find((a) => a.agentName === "ARSENKIN_AI_SEARCH_REAL")!;
    const top = state.agents.find((a) => a.agentName === "ARSENKIN_SEARCH_TOP_REAL")!;
    expect(agentWasDisabled(ai, state)).toBe(true);
    expect(agentWasDisabled(top, state)).toBe(false);
  });

  it("ложь для оффлайн-состояния, где ранов нет ни у кого", () => {
    // Оффлайн отправка пропускается целиком: все пятеро завершаются
    // EMPTY_VALID без рана. Это не «состав прогона», а отсутствие сети.
    const state = {
      agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName) => agent({ agentName })),
    } as ArsenkinEnrichmentState;
    for (const a of state.agents) expect(agentWasDisabled(a, state)).toBe(false);
  });

  it("ложь для EMPTY_VALID с раном и для SUCCESS", () => {
    const state = {
      agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) =>
        agent({ agentName, enrichmentRunId: `offline-arsenkin-${i}` })
      ),
    } as ArsenkinEnrichmentState;
    for (const a of state.agents) expect(agentWasDisabled(a, state)).toBe(false);

    const measured = run76State();
    const paa = measured.agents.find((a) => a.agentName === "ARSENKIN_PAA_REAL")!;
    expect(agentWasDisabled(paa, measured)).toBe(false);
  });
});

describe("счётчики покрытия джобы", () => {
  it("выключенные агенты идут в notSupported, а не в noResults", () => {
    const state = {
      ...run76State({ terminalKind: "DISABLED" }),
      pendingAgents: [],
      failedAgents: [],
      completedAgents: ARSENKIN_REAL_AGENT_NAMES as unknown as string[],
      enrichmentObservationCount: 250,
    } as ArsenkinEnrichmentState;
    const coverage = surfaceCoverageFromEnrichmentState(state);
    expect(coverage.notSupported).toBe(2);
    expect(coverage.noResults).toBe(0);
  });

  it("агент, вернувший пустоту после задач, остаётся в noResults", () => {
    const state = {
      ...run76State(),
      pendingAgents: [],
      failedAgents: [],
      completedAgents: ARSENKIN_REAL_AGENT_NAMES as unknown as string[],
      enrichmentObservationCount: 250,
      agents: [
        agent({
          agentName: "ARSENKIN_PAA_REAL",
          enrichmentRunId: "orion-arsenkin-agent-paa-1",
          terminalKind: "EMPTY_VALID",
          doneTaskCount: 2,
        }),
      ],
    } as ArsenkinEnrichmentState;
    expect(surfaceCoverageFromEnrichmentState(state).noResults).toBe(1);
    expect(surfaceCoverageFromEnrichmentState(state).notSupported).toBe(0);
  });
});

describe("ячейки покрытия по не заданным вопросам", () => {
  it("выключенный ai-serp даёт ячейки всех своих слотов", () => {
    const cells = disabledSurfaceCoverageCells(run76State({ terminalKind: "DISABLED" }));
    const ai = cells.filter((c) => c.surface === "ai_answers");
    expect(ai).toEqual([
      {
        region: "RU",
        engine: "YANDEX",
        surface: "ai_answers",
        status: "NOT_COLLECTED",
        provider: "arsenkin",
        errorCode: "DISABLED_BY_TOOLS",
      },
      {
        region: "RU",
        engine: "GOOGLE",
        surface: "ai_answers",
        status: "NOT_COLLECTED",
        provider: "arsenkin",
        errorCode: "DISABLED_BY_TOOLS",
      },
      {
        region: "UAE",
        engine: "GOOGLE",
        surface: "ai_answers",
        status: "NOT_COLLECTED",
        provider: "arsenkin",
        errorCode: "DISABLED_BY_TOOLS",
      },
    ]);
  });

  it("выключенный аудит URL даёт свою ячейку", () => {
    const cells = disabledSurfaceCoverageCells(run76State({ terminalKind: "DISABLED" }));
    expect(cells.filter((c) => c.surface === "url_audit")).toEqual([
      {
        region: "MIXED",
        engine: "MULTI",
        surface: "url_audit",
        status: "NOT_COLLECTED",
        provider: "arsenkin",
        errorCode: "DISABLED_BY_TOOLS",
      },
    ]);
  });

  it("легаси-форма прогона 76 даёт те же ячейки", () => {
    expect(disabledSurfaceCoverageCells(run76State())).toHaveLength(4);
  });

  it("состояния нет или выключенных нет — ячеек нет", () => {
    expect(disabledSurfaceCoverageCells(null)).toEqual([]);
    expect(disabledSurfaceCoverageCells(undefined)).toEqual([]);
    // Голден-фикстура: агенты названы инструментами, ранов нет, задач нет.
    expect(
      disabledSurfaceCoverageCells({
        enrichmentComplete: true,
        agents: [
          { agentName: "ai-serp", terminalKind: "EMPTY_VALID", observationCount: 12 },
          { agentName: "suggest", terminalKind: "EMPTY_VALID", observationCount: 54 },
        ],
      })
    ).toEqual([]);
  });
});
