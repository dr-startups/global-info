/**
 * Обогащение считается завершённым по составу прогона, а не по полному каталогу.
 *
 * Поймано на боевом прогоне 28.07 (Тиньков, полный аудит). Три агента состава
 * отработали и отдали наблюдения:
 *
 *     dp_agent_runs:      ARSENKIN_SEARCH_TOP_REAL   SUCCEEDED
 *                         ARSENKIN_SUGGESTIONS_REAL  SUCCEEDED
 *                         ARSENKIN_PAA_REAL          SUCCEEDED
 *     dp_provider_tasks:  check-top DONE ×2, paa DONE ×2, suggest DONE ×3
 *     наблюдений:         522
 *
 * А состояние прогона показывало `pendingAgents` из пяти, `completedAgents`
 * пустым и `enrichmentComplete: false`. Шаг ждал продвижения, которого уже не
 * могло быть — работа была сделана, — счётчик простоя дошёл до сорока, и
 * стадия упала с `ARSENKIN_POLL_ATTEMPTS_EXCEEDED`.
 *
 * Причина: полнота сверялась с длиной **каталога** всех агентов (пять), а
 * составом по умолчанию после ADR-0005 работают трое. Условие не могло стать
 * истинным никогда.
 *
 * Это тот же вопрос, что закрывает `enabledArsenkinAgentNames`: «какие агенты
 * участвуют в прогоне». Ответ на него один, и полнота обязана спрашивать его,
 * а не считать строки каталога.
 */

import { describe, expect, it } from "vitest";
import {
  deriveEnrichmentProgress,
  type ProviderTaskFact,
} from "../../src/modules/digital-profile/services/arsenkin-progress-derivation";
import {
  ARSENKIN_REAL_AGENT_NAMES,
  enabledArsenkinAgentNames,
} from "../../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import {
  buildArsenkinEnrichmentState,
  emptyArsenkinEnrichmentState,
} from "../../src/modules/digital-profile/services/arsenkin-enrichment-state";

/** Состав ADR-0005: первая стадия. */
const FIRST_STAGE = [
  "ARSENKIN_SEARCH_TOP_REAL",
  "ARSENKIN_SUGGESTIONS_REAL",
  "ARSENKIN_PAA_REAL",
] as const;

function runIds(agents: readonly string[]): Record<string, string> {
  return Object.fromEntries(agents.map((a) => [a, `run-${a.toLowerCase()}`]));
}

/** Задачи прогона: у каждого агента свои, все завершённые. */
function doneTasks(agents: readonly string[]): ProviderTaskFact[] {
  return agents.flatMap((a) => [
    { reportRunId: `run-${a.toLowerCase()}`, state: "DONE" },
    { reportRunId: `run-${a.toLowerCase()}`, state: "DONE" },
  ]);
}

describe("завершённость обогащения и состав прогона", () => {
  it("состав по умолчанию — не весь каталог", () => {
    // Если это перестанет быть так, проверка ниже потеряет смысл, и лучше
    // узнать об этом здесь.
    expect(enabledArsenkinAgentNames().length).toBeLessThan(ARSENKIN_REAL_AGENT_NAMES.length);
  });

  it("наблюдавшийся случай: три агента состава отработали — обогащение завершено", () => {
    const p = deriveEnrichmentProgress({
      enrichmentRunIdByAgent: runIds(FIRST_STAGE),
      tasks: doneTasks(FIRST_STAGE),
      observationCount: 522,
    });
    expect(p.scheduledAgents.sort()).toEqual([...FIRST_STAGE].sort());
    expect(p.completedAgents.sort()).toEqual([...FIRST_STAGE].sort());
    expect(p.pendingAgents).toEqual([]);
    expect(p.failedAgents).toEqual([]);
    expect(p.enrichmentComplete).toBe(true);
  });

  it("незавершённая задача состава держит обогащение незавершённым", () => {
    const tasks = doneTasks(FIRST_STAGE);
    tasks[0] = { reportRunId: tasks[0]!.reportRunId, state: "RUNNING" };
    const p = deriveEnrichmentProgress({
      enrichmentRunIdByAgent: runIds(FIRST_STAGE),
      tasks,
      observationCount: 100,
    });
    expect(p.pendingAgents.length).toBe(1);
    expect(p.enrichmentComplete).toBe(false);
  });

  it("агент состава без единой задачи не даёт объявить обогащение завершённым", () => {
    // Отправка не состоялась — это не «готово», а «ещё не начиналось».
    const partial = FIRST_STAGE.slice(0, 2);
    const p = deriveEnrichmentProgress({
      enrichmentRunIdByAgent: runIds(FIRST_STAGE),
      tasks: doneTasks(partial),
      observationCount: 10,
    });
    expect(p.scheduledAgents.length).toBe(2);
    expect(p.enrichmentComplete).toBe(false);
  });

  it("упавший агент состава оставляет обогащение незавершённым", () => {
    const tasks = [
      ...doneTasks(FIRST_STAGE.slice(0, 2)),
      { reportRunId: `run-${FIRST_STAGE[2].toLowerCase()}`, state: "FAILED" },
    ];
    const p = deriveEnrichmentProgress({
      enrichmentRunIdByAgent: runIds(FIRST_STAGE),
      tasks,
      observationCount: 10,
    });
    expect(p.failedAgents.length).toBe(1);
    expect(p.enrichmentComplete).toBe(false);
  });

  it("живой путь: состояние строится по составу, а не по каталогу", () => {
    // Ровно то, что показывал прогон: три агента отработали и приняты.
    const state = buildArsenkinEnrichmentState({
      caseId: "c1",
      unifiedJobId: "j1",
      agents: FIRST_STAGE.map((agentName) => ({
        agentName,
        enrichmentRunId: `run-${agentName.toLowerCase()}`,
        scheduled: true,
        terminal: true,
        terminalKind: "SUCCESS" as const,
        ingested: true,
        pendingTaskCount: 0,
        doneTaskCount: 2,
        submitUnknownCount: 0,
        observationCount: 174,
      })),
    });
    expect(state.pendingAgents).toEqual([]);
    expect(state.completedAgents.sort()).toEqual([...FIRST_STAGE].sort());
    expect(state.ingestedAgents.sort()).toEqual([...FIRST_STAGE].sort());
    expect(state.enrichmentObservationCount).toBe(522);
    expect(state.enrichmentComplete).toBe(true);
  });

  it("пустое состояние ждёт состав, а не весь каталог", () => {
    const s = emptyArsenkinEnrichmentState({ caseId: "c1", unifiedJobId: "j1" });
    expect(s.pendingAgents.sort()).toEqual([...enabledArsenkinAgentNames()].sort());
    expect(s.pendingAgents.length).toBeLessThan(ARSENKIN_REAL_AGENT_NAMES.length);
  });
});
