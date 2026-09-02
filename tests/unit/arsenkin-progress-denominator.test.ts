/**
 * Знаменатель прогресса Arsenkin — состав прогона, а не число «5».
 *
 * При составе по умолчанию (ADR-0005 — работает только первая стадия) в деле
 * три агента. Кабинет показывал «scheduled 3/5 · completed 3/5 · ingested 3/5
 * (complete)»: исправный завершённый прогон выглядел недоделанным, причём в
 * интерфейсе, который показывают заказчику. Знаменатель был записан числом —
 * шестью литералами `5` в одной функции, — и это был второй ответ на вопрос
 * «сколько агентов в деле», на который состав уже отвечает.
 *
 * Свойство: сколько агентов включено составом, столько и в знаменателе.
 */

import { describe, expect, it } from "vitest";
import {
  arsenkinAgentTotal,
  arsenkinProgressLine,
} from "../../src/modules/digital-profile/client/arsenkin-progress-line";
import {
  ARSENKIN_REAL_AGENT_NAMES,
  enabledArsenkinAgentNames,
} from "../../src/modules/digital-profile/agents/real/real-arsenkin-agents";

/** Окружение только с составом инструментов — остальное берём как есть. */
function envWithTools(tools: string): NodeJS.ProcessEnv {
  return { ...process.env, ARSENKIN_TOOLS: tools };
}

/** Состав ADR-0005: первая стадия — три агента из пяти. */
const FIRST_STAGE = [
  "ARSENKIN_SEARCH_TOP_REAL",
  "ARSENKIN_SUGGESTIONS_REAL",
  "ARSENKIN_PAA_REAL",
];

describe("знаменатель прогресса Arsenkin", () => {
  it("равен числу включённых составом агентов, а не пяти", () => {
    const line = arsenkinProgressLine({
      plannedAgents: FIRST_STAGE,
      scheduledAgents: FIRST_STAGE,
      completedAgents: FIRST_STAGE,
      ingestedAgents: FIRST_STAGE,
      enrichmentComplete: true,
    });
    expect(line).toBe(
      "scheduled 3/3 · completed 3/3 · ingested 3/3 (complete)"
    );
    // Отключённые составом в знаменатель не попадают.
    expect(line).not.toContain("/5");
  });

  it("полный состав даёт полный знаменатель", () => {
    const all = [...ARSENKIN_REAL_AGENT_NAMES];
    expect(arsenkinAgentTotal({ plannedAgents: all })).toBe(all.length);
  });

  it("до постановки задач знаменатель уже известен — из состава", () => {
    expect(arsenkinProgressLine({ plannedAgents: FIRST_STAGE })).toBe(
      "scheduled 0/3 · completed 0/3 · ingested 0/3"
    );
  });

  it("без названного состава знаменатель берётся из данных, а не из литерала", () => {
    // Старый ответ без поля: считаем агентов, которые в прогоне встретились.
    expect(
      arsenkinAgentTotal({
        scheduledAgents: ["A", "B"],
        completedAgents: ["A"],
        pendingAgents: ["B"],
      })
    ).toBe(2);
  });

  it("числитель не обгоняет знаменатель", () => {
    const line = arsenkinProgressLine({
      plannedAgents: FIRST_STAGE,
      scheduledAgents: [...FIRST_STAGE, "ARSENKIN_AI_SEARCH_REAL"],
      enrichmentComplete: false,
    });
    expect(line).toContain("scheduled 3/3");
  });

  it("состав считается по инструментам, а не по списку имён", () => {
    const onlyFirstStage = enabledArsenkinAgentNames(envWithTools("check-top,suggest,paa"));
    expect(onlyFirstStage).toEqual(FIRST_STAGE);
    expect(onlyFirstStage.length).toBeLessThan(ARSENKIN_REAL_AGENT_NAMES.length);

    const withAiSerp = enabledArsenkinAgentNames(envWithTools("check-top,ai-serp"));
    expect(withAiSerp).toContain("ARSENKIN_AI_SEARCH_REAL");
    expect(withAiSerp).not.toContain("ARSENKIN_PAA_REAL");
  });
});
