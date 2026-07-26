import { describe, expect, it } from "vitest";
import {
  deriveEnrichmentProgress,
  detectEnrichmentProgressDrift,
  enrichmentDriftWarnings,
  type ProviderTaskFact,
} from "../../src/modules/digital-profile/services/arsenkin-progress-derivation";
import { ARSENKIN_REAL_AGENT_NAMES } from "../../src/modules/digital-profile/agents/real/real-arsenkin-agents";

/**
 * Шаг 12.4d (docs/rework/12-durable-step-execution.md).
 *
 * Прогресс обогащения хранился вторым экземпляром в блобе
 * `arsenkinEnrichmentState`, и расхождения этого экземпляра с реальными
 * строками `ProviderTask` дали дефекты 08.0-bis («пять прогонов
 * зарегистрировано, задач две») и 11.1.
 *
 * Здесь тот же вопрос задаётся фактам. Пока это детектор: он показывает
 * расхождение, а не меняет поведение.
 */

const RUNS = Object.fromEntries(
  ARSENKIN_REAL_AGENT_NAMES.map((a) => [a, `run-${a.toLowerCase()}`])
) as Record<string, string>;

const task = (agent: string, state: string): ProviderTaskFact => ({
  reportRunId: RUNS[agent]!,
  state,
});

const derive = (tasks: ProviderTaskFact[], observationCount = 0) =>
  deriveEnrichmentProgress({ enrichmentRunIdByAgent: RUNS, tasks, observationCount });

describe("прогресс выводится из строк задач", () => {
  it("агент без строки задачи запланированным не считается", () => {
    // Ровно дефект 08.0-bis: сводка говорила «зарегистрирован», задачи не было.
    expect(derive([]).scheduledAgents).toEqual([]);
  });

  it("строка задачи делает агента запланированным", () => {
    const p = derive([task("ARSENKIN_SEARCH_TOP_REAL", "RUNNING")]);
    expect(p.scheduledAgents).toEqual(["ARSENKIN_SEARCH_TOP_REAL"]);
    expect(p.pendingAgents).toEqual(["ARSENKIN_SEARCH_TOP_REAL"]);
    expect(p.completedAgents).toEqual([]);
  });

  it("все задачи агента закрыты — агент завершён", () => {
    const p = derive([
      task("ARSENKIN_SEARCH_TOP_REAL", "DONE"),
      task("ARSENKIN_SEARCH_TOP_REAL", "DONE"),
    ]);
    expect(p.completedAgents).toEqual(["ARSENKIN_SEARCH_TOP_REAL"]);
    expect(p.pendingAgents).toEqual([]);
  });

  it("одна незакрытая задача держит агента в работе", () => {
    const p = derive([
      task("ARSENKIN_SEARCH_TOP_REAL", "DONE"),
      task("ARSENKIN_SEARCH_TOP_REAL", "RUNNING"),
    ]);
    expect(p.pendingAgents).toEqual(["ARSENKIN_SEARCH_TOP_REAL"]);
    expect(p.completedAgents).toEqual([]);
  });

  it("упавшая задача агента не держит", () => {
    // FAILED — это тоже терминальное состояние: ждать больше нечего.
    expect(derive([task("ARSENKIN_PAA_REAL", "FAILED")]).completedAgents).toEqual([
      "ARSENKIN_PAA_REAL",
    ]);
  });

  it("полнота требует всех пяти агентов", () => {
    const four = ARSENKIN_REAL_AGENT_NAMES.slice(0, 4).map((a) => task(a, "DONE"));
    expect(derive(four).enrichmentComplete).toBe(false);
    const five = ARSENKIN_REAL_AGENT_NAMES.map((a) => task(a, "DONE"));
    expect(derive(five).enrichmentComplete).toBe(true);
  });

  it("пять отправленных, один в работе — ещё не полнота", () => {
    const tasks = ARSENKIN_REAL_AGENT_NAMES.map((a, i) =>
      task(a, i === 2 ? "RUNNING" : "DONE")
    );
    expect(derive(tasks).enrichmentComplete).toBe(false);
  });

  it("задача чужого прогона в счёт не идёт", () => {
    expect(derive([{ reportRunId: "run-other", state: "DONE" }]).scheduledAgents).toEqual([]);
  });
});

describe("расхождение хранимого и выведенного", () => {
  const stored = (over: Record<string, unknown> = {}) =>
    ({
      scheduledAgents: [],
      completedAgents: [],
      enrichmentComplete: false,
      ...over,
    }) as never;

  it("совпадение расхождения не даёт", () => {
    const tasks = ARSENKIN_REAL_AGENT_NAMES.map((a) => task(a, "DONE"));
    const d = derive(tasks);
    const drift = detectEnrichmentProgressDrift(
      stored({
        scheduledAgents: [...ARSENKIN_REAL_AGENT_NAMES],
        completedAgents: [...ARSENKIN_REAL_AGENT_NAMES],
        enrichmentComplete: true,
      }),
      d
    );
    expect(drift).toEqual([]);
  });

  it("ловит «зарегистрировано пять, задач две»", () => {
    // Именно это состояние проходило прежнюю проверку и уводило
    // восстановление опрашивать несуществующие задачи (шаг 08.0-bis).
    const twoTasks = ARSENKIN_REAL_AGENT_NAMES.slice(0, 2).map((a) => task(a, "RUNNING"));
    const drift = detectEnrichmentProgressDrift(
      stored({ scheduledAgents: [...ARSENKIN_REAL_AGENT_NAMES] }),
      derive(twoTasks)
    );
    expect(drift.map((d) => d.field)).toContain("scheduledAgents");
  });

  it("ловит ложную полноту", () => {
    const drift = detectEnrichmentProgressDrift(
      stored({ enrichmentComplete: true }),
      derive([task("ARSENKIN_PAA_REAL", "RUNNING")])
    );
    expect(drift.map((d) => d.field)).toContain("enrichmentComplete");
  });

  it("порядок агентов расхождением не считается", () => {
    const tasks = ARSENKIN_REAL_AGENT_NAMES.map((a) => task(a, "DONE"));
    const drift = detectEnrichmentProgressDrift(
      stored({
        scheduledAgents: [...ARSENKIN_REAL_AGENT_NAMES].reverse(),
        completedAgents: [...ARSENKIN_REAL_AGENT_NAMES].reverse(),
        enrichmentComplete: true,
      }),
      derive(tasks)
    );
    expect(drift).toEqual([]);
  });

  it("отсутствие сводки расхождением не считается", () => {
    expect(detectEnrichmentProgressDrift(null, derive([]))).toEqual([]);
  });

  it("предупреждение называет поле и оба ответа", () => {
    const w = enrichmentDriftWarnings([
      { field: "enrichmentComplete", stored: "true", derived: "false" },
    ]);
    expect(w).toEqual(["enrichment-progress-drift:enrichmentComplete:true!=false"]);
  });
});
