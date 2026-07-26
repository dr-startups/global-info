import { describe, expect, it } from "vitest";
import {
  computeArsenkinSubmissionGap,
  describeSubmissionGap,
  type SubmissionGapTask,
} from "../../src/modules/digital-profile/services/arsenkin-submission-gap";
import {
  agentNameFromEnrichmentRunId,
  mergeAgentEnrichmentRunId,
} from "../../src/modules/digital-profile/services/unified-enrichment-sibling-remap";
import { ARSENKIN_REAL_AGENT_NAMES } from "../../src/modules/digital-profile/agents/real/real-arsenkin-agents";

/**
 * Шаг 08.0-bis плана.
 *
 * Наблюдавшееся состояние: пять прогонов зарегистрировано, задач у провайдера
 * две. Возобновление опиралось на число прогонов, поэтому включало режим
 * импорта и опрашивало результаты несуществующих задач сорок попыток подряд,
 * после чего падало с ARSENKIN_POLL_ATTEMPTS_EXCEEDED. Повторное
 * восстановление приводило туда же — выхода из состояния не было.
 */

const JOB = "job-1";
const runId = (agent: string) => `unified-${JOB}-${agent}`;
const ALL_RUN_IDS = ARSENKIN_REAL_AGENT_NAMES.map(runId);

function task(over: Partial<SubmissionGapTask>): SubmissionGapTask {
  return { reportRunId: null, toolName: null, externalTaskId: "ext-1", ...over };
}

describe("разрыв между регистрацией и отправкой", () => {
  it("зарегистрированный агент без задачи подлежит отправке, а не опросу", () => {
    // Ровно наблюдавшийся случай: задачи есть только у check-top.
    const gap = computeArsenkinSubmissionGap({
      enrichmentRunIds: ALL_RUN_IDS,
      tasks: [
        task({ reportRunId: runId("ARSENKIN_SEARCH_TOP_REAL"), toolName: "check-top" }),
        task({ reportRunId: runId("ARSENKIN_SEARCH_TOP_REAL"), toolName: "check-top" }),
      ],
    });

    expect(gap.submitted).toEqual(["ARSENKIN_SEARCH_TOP_REAL"]);
    expect(gap.registeredWithoutTask).toEqual([
      "ARSENKIN_SUGGESTIONS_REAL",
      "ARSENKIN_PAA_REAL",
      "ARSENKIN_AI_SEARCH_REAL",
      "ARSENKIN_URL_AUDIT_REAL",
    ]);
    expect(gap.unregistered).toEqual([]);
  });

  it("агент с задачами не попадает в отправку повторно", () => {
    const gap = computeArsenkinSubmissionGap({
      enrichmentRunIds: ALL_RUN_IDS,
      tasks: ARSENKIN_REAL_AGENT_NAMES.map((a) => task({ reportRunId: runId(a) })),
    });
    expect(gap.needsSubmit).toEqual([]);
    expect(gap.submitted).toHaveLength(ARSENKIN_REAL_AGENT_NAMES.length);
  });

  it("неподтверждённая отправка остаётся на опросе — повтор стоил бы денег дважды", () => {
    // Строка ProviderTask без externalTaskId: задача у провайдера могла быть
    // создана, подтверждение не дошло. Отправлять заново нельзя.
    const gap = computeArsenkinSubmissionGap({
      enrichmentRunIds: ALL_RUN_IDS,
      tasks: [task({ reportRunId: runId("ARSENKIN_PAA_REAL"), externalTaskId: null })],
    });
    expect(gap.submitted).toContain("ARSENKIN_PAA_REAL");
    expect(gap.needsSubmit).not.toContain("ARSENKIN_PAA_REAL");
  });

  it("пустой список прогонов даёт отправку всех пяти", () => {
    const gap = computeArsenkinSubmissionGap({ enrichmentRunIds: [], tasks: [] });
    expect(gap.needsSubmit).toEqual([...ARSENKIN_REAL_AGENT_NAMES]);
    expect(gap.unregistered).toEqual([...ARSENKIN_REAL_AGENT_NAMES]);
    expect(gap.registeredWithoutTask).toEqual([]);
  });

  it("задача опознаётся по инструменту, даже если прогон пришёл из ручного запуска", () => {
    const gap = computeArsenkinSubmissionGap({
      enrichmentRunIds: ALL_RUN_IDS,
      tasks: [task({ reportRunId: "manual-run-42", toolName: "ai-serp" })],
    });
    expect(gap.submitted).toContain("ARSENKIN_AI_SEARCH_REAL");
  });

  it("диагностика различает незарегистрированных и неотправленных", () => {
    const lines = describeSubmissionGap({
      needsSubmit: ["ARSENKIN_PAA_REAL", "ARSENKIN_URL_AUDIT_REAL"],
      submitted: [],
      unregistered: ["ARSENKIN_URL_AUDIT_REAL"],
      registeredWithoutTask: ["ARSENKIN_PAA_REAL"],
    });
    expect(lines).toContain("arsenkin-registered-without-task:ARSENKIN_PAA_REAL");
    expect(lines).toContain("arsenkin-unregistered:ARSENKIN_URL_AUDIT_REAL");
  });
});

describe("атрибуция прогона агенту", () => {
  it("опознаёт собственный формат идентификатора", () => {
    for (const agent of ARSENKIN_REAL_AGENT_NAMES) {
      expect(agentNameFromEnrichmentRunId(runId(agent))).toBe(agent);
    }
  });

  it("опознаёт человеческий формат из ручных запусков", () => {
    expect(agentNameFromEnrichmentRunId("case-7-search-top-2")).toBe("ARSENKIN_SEARCH_TOP_REAL");
    expect(agentNameFromEnrichmentRunId("case-7-ai-search-1")).toBe("ARSENKIN_AI_SEARCH_REAL");
    expect(agentNameFromEnrichmentRunId("case-7-url-audit-1")).toBe("ARSENKIN_URL_AUDIT_REAL");
  });

  it("не выдумывает агента для постороннего идентификатора", () => {
    expect(agentNameFromEnrichmentRunId("base-collection-1")).toBeNull();
    expect(agentNameFromEnrichmentRunId("")).toBeNull();
  });

  it("отправка заменяет прогон агента, а не добавляет второй", () => {
    // С узким шаблоном `unified-<job>-ARSENKIN_SEARCH_TOP_REAL` не опознавался
    // как прогон своего агента, и список получал два его идентификатора.
    const merged = mergeAgentEnrichmentRunId(
      ALL_RUN_IDS,
      "ARSENKIN_SEARCH_TOP_REAL",
      "fresh-search-top-run"
    );
    expect(merged).toHaveLength(ALL_RUN_IDS.length);
    expect(merged).toContain("fresh-search-top-run");
    expect(merged).not.toContain(runId("ARSENKIN_SEARCH_TOP_REAL"));
  });

  it("отправка не трогает прогоны остальных агентов", () => {
    const merged = mergeAgentEnrichmentRunId(ALL_RUN_IDS, "ARSENKIN_PAA_REAL", "fresh-paa-run");
    for (const agent of ARSENKIN_REAL_AGENT_NAMES) {
      if (agent === "ARSENKIN_PAA_REAL") continue;
      expect(merged).toContain(runId(agent));
    }
  });
});
