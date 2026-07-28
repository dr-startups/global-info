import { describe, expect, it } from "vitest";
import {
  classifyAgentTasks,
  deriveEnrichmentProgress,
  detectEnrichmentProgressDrift,
  enrichmentDriftWarnings,
  type ProviderTaskFact,
} from "../../src/modules/digital-profile/services/arsenkin-progress-derivation";
import { ARSENKIN_REAL_AGENT_NAMES, enabledArsenkinAgentNames } from "../../src/modules/digital-profile/agents/real/real-arsenkin-agents";

/**
 * Шаг 12.4d, пересмотрен на шаге 16 (K1).
 *
 * Задача формулировалась как «перевести читателей прогресса с блоба на вывод из
 * фактов». Разбор показал, что формулировка неверна: блоб не второй независимый
 * ответ, он и так строится из строк `ProviderTask` тиком. А прежний вывод здесь
 * считал завершённым агента, все задачи которого `FAILED`, — то есть перевод
 * читателей на него пропустил бы конвейер мимо упавшего агента.
 *
 * Осталось одно правило классификации на оба места и односторонняя сверка на
 * устаревание блоба.
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

describe("классификация задач агента — одна на тик и на сверку", () => {
  it("живая задача держит агента в работе", () => {
    const c = classifyAgentTasks([{ state: "RUNNING" }, { state: "DONE" }]);
    expect(c.terminal).toBe(false);
    expect(c.failureKind).toBeNull();
  });

  it("отказ отправки без единой DONE — неразобранный SUBMIT_UNKNOWN", () => {
    const c = classifyAgentTasks([{ state: "SUBMIT_REJECTED_RETRYABLE" }]);
    expect(c.terminal).toBe(true);
    expect(c.failureKind).toBe("SUBMIT_UNKNOWN_UNRECONCILED");
  });

  it("полученная нагрузка важнее отказа отправки соседа", () => {
    // Целевой повтор оставляет отклонённый Google suggest рядом с готовым Yandex.
    const c = classifyAgentTasks([{ state: "SUBMIT_REJECTED_RETRYABLE" }, { state: "DONE" }]);
    expect(c.terminal).toBe(true);
    expect(c.failureKind).toBeNull();
  });

  it("падение без единой DONE — отказ", () => {
    for (const s of ["FAILED", "ERROR", "TIMEOUT", "CANCELLED"]) {
      expect(classifyAgentTasks([{ state: s }]).failureKind, s).toBe("FAILED");
    }
  });

  it("без строк задач сказать нечего", () => {
    const c = classifyAgentTasks([]);
    expect(c.terminal).toBe(false);
    expect(c.failureKind).toBeNull();
  });

  it("регистр состояния роли не играет", () => {
    expect(classifyAgentTasks([{ state: "running" }]).terminal).toBe(false);
    expect(classifyAgentTasks([{ state: "done" }]).terminal).toBe(true);
  });
});

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

  it("упавший агент завершённым не считается", () => {
    // Прежняя версия относила его к `completedAgents`: `FAILED` для неё было
    // просто «терминальное состояние». Настоящее правило
    // (`buildArsenkinEnrichmentState`) держит упавших отдельно — иначе конвейер
    // поехал бы мимо отказа.
    const p = derive([task("ARSENKIN_PAA_REAL", "FAILED")]);
    expect(p.failedAgents).toEqual(["ARSENKIN_PAA_REAL"]);
    expect(p.completedAgents).toEqual([]);
  });

  it("полнота требует всех агентов состава, а не всего каталога", () => {
    // Проверка держала формулировку «все пять», и это оказалось дефектом:
    // составом по умолчанию (ADR-0005) работают трое, поэтому условие не
    // становилось истинным никогда. На боевом прогоне 28.07 три агента отдали
    // 522 наблюдения, все задачи DONE — а стадия ждала пятерых и упала по
    // счётчику простоя. Свойство теперь про состав.
    const composition = enabledArsenkinAgentNames();
    expect(composition.length).toBeGreaterThan(0);

    const all = composition.map((a) => task(a, "DONE"));
    expect(derive(all).enrichmentComplete).toBe(true);

    const missingOne = composition.slice(0, -1).map((a) => task(a, "DONE"));
    expect(derive(missingOne).enrichmentComplete).toBe(false);
  });

  it("агент вне состава полноту не держит", () => {
    // Отключённый составом не отправляется и не ждётся (0f0b2b1) — значит и
    // ждать его завершения нельзя.
    const outside = ARSENKIN_REAL_AGENT_NAMES.filter(
      (a) => !enabledArsenkinAgentNames().includes(a)
    );
    expect(outside.length).toBeGreaterThan(0);
    const all = enabledArsenkinAgentNames().map((a) => task(a, "DONE"));
    expect(derive(all).scheduledAgents).not.toContain(outside[0]!);
    expect(derive(all).enrichmentComplete).toBe(true);
  });

  it("пять отправленных, один в работе — ещё не полнота", () => {
    const tasks = ARSENKIN_REAL_AGENT_NAMES.map((a, i) =>
      task(a, i === 2 ? "RUNNING" : "DONE")
    );
    expect(derive(tasks).enrichmentComplete).toBe(false);
  });

  it("пять отправленных, один упал — не полнота", () => {
    // Прогон, где `ARSENKIN_URL_AUDIT_REAL` вернул FAILED: отчёт собирается,
    // но полнотой обогащения это не является.
    const tasks = ARSENKIN_REAL_AGENT_NAMES.map((a, i) => task(a, i === 4 ? "FAILED" : "DONE"));
    expect(derive(tasks).enrichmentComplete).toBe(false);
  });

  it("задача чужого прогона в счёт не идёт", () => {
    expect(derive([{ reportRunId: "run-other", state: "DONE" }]).scheduledAgents).toEqual([]);
  });
});

describe("сверка ловит опережение блоба, а не отставание фактов", () => {
  const stored = (over: Record<string, unknown> = {}) =>
    ({
      scheduledAgents: [],
      completedAgents: [],
      enrichmentComplete: false,
      ...over,
    }) as never;

  it("совпадение расхождения не даёт", () => {
    const tasks = ARSENKIN_REAL_AGENT_NAMES.map((a) => task(a, "DONE"));
    const drift = detectEnrichmentProgressDrift(
      stored({
        scheduledAgents: [...ARSENKIN_REAL_AGENT_NAMES],
        completedAgents: [...ARSENKIN_REAL_AGENT_NAMES],
        enrichmentComplete: true,
      }),
      derive(tasks)
    );
    expect(drift).toEqual([]);
  });

  it("разница в «запланировано» тревогой не считается", () => {
    // В сводке это «намерены запустить», в выводе — «есть строка задачи».
    // Пока задачи создаются по очереди, расхождение здесь норма (шаг 15, I2).
    const twoTasks = ARSENKIN_REAL_AGENT_NAMES.slice(0, 2).map((a) => task(a, "RUNNING"));
    const drift = detectEnrichmentProgressDrift(
      stored({ scheduledAgents: [...ARSENKIN_REAL_AGENT_NAMES] }),
      derive(twoTasks)
    );
    expect(drift.map((d) => d.field)).not.toContain("scheduledAgents");
  });

  it("завершённым назван агент, у которого задача ещё идёт", () => {
    const drift = detectEnrichmentProgressDrift(
      stored({ completedAgents: ["ARSENKIN_PAA_REAL"] }),
      derive([task("ARSENKIN_PAA_REAL", "RUNNING")])
    );
    expect(drift.map((d) => d.field)).toContain("completedAgents");
    expect(drift[0]?.stored).toBe("ARSENKIN_PAA_REAL");
  });

  it("полнота при незакрытых задачах — тревога", () => {
    const drift = detectEnrichmentProgressDrift(
      stored({ enrichmentComplete: true }),
      derive([task("ARSENKIN_PAA_REAL", "RUNNING")])
    );
    expect(drift.map((d) => d.field)).toContain("enrichmentComplete");
  });

  it("блоб знает про отказ, которого в строках не видно, — не тревога", () => {
    // Ошибка схемы: задачи DONE, но нагрузка не разбирается. Тик знает больше
    // строк задач, и это норма, а не расхождение. Прежняя двусторонняя сверка
    // подняла бы здесь ложную тревогу.
    const tasks = ARSENKIN_REAL_AGENT_NAMES.map((a) => task(a, "DONE"));
    const drift = detectEnrichmentProgressDrift(
      stored({
        scheduledAgents: [...ARSENKIN_REAL_AGENT_NAMES],
        completedAgents: ARSENKIN_REAL_AGENT_NAMES.slice(0, 4),
        failedAgents: [ARSENKIN_REAL_AGENT_NAMES[4]],
        enrichmentComplete: false,
      }),
      derive(tasks)
    );
    expect(drift).toEqual([]);
  });

  it("блоб отстаёт и ещё не знает о завершении — не тревога", () => {
    // Сохранённая запись старше строк задач в безопасную сторону: она заявляет
    // меньше готовности, чем есть. Работу это не разблокирует.
    const tasks = ARSENKIN_REAL_AGENT_NAMES.map((a) => task(a, "DONE"));
    expect(detectEnrichmentProgressDrift(stored({}), derive(tasks))).toEqual([]);
  });

  it("порядок агентов расхождением не считается", () => {
    const tasks = ARSENKIN_REAL_AGENT_NAMES.map((a) => task(a, "DONE"));
    const drift = detectEnrichmentProgressDrift(
      stored({
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
      { field: "enrichmentComplete", stored: "true", derived: "pending=1 failed=0 scheduled=1" },
    ]);
    expect(w).toEqual([
      "enrichment-progress-drift:enrichmentComplete:true!=pending=1 failed=0 scheduled=1",
    ]);
  });
});

/**
 * Шаг 15, I1 — автоматический дозапуск не замещает живое исполнение.
 *
 * Тик предлагает отправку каждому агенту без строки `ProviderTask` на каждом
 * обороте. Прежде каждый заход помечал предыдущее исполнение
 * `ARSENKIN_SUPERSEDED`, и на здоровом прогоне оператор видел во вкладке
 * «Агенты» четыре отказа подряд.
 */
describe("живое исполнение агента автоматикой не замещается", () => {
  it("свежее исполнение считается живым", async () => {
    const { isStaleCaseAgentExecution } = await import(
      "../../src/modules/digital-profile/services/arsenkin-case-agent-execution/submit"
    );
    const now = new Date("2026-07-26T12:00:00Z");
    const fresh = { updatedAt: "2026-07-26T11:58:00Z", phase: "COLLECTING" };
    expect(isStaleCaseAgentExecution(fresh, now)).toBe(false);
  });

  it("исполнение, молчащее дольше порога, замещается", async () => {
    const { isStaleCaseAgentExecution } = await import(
      "../../src/modules/digital-profile/services/arsenkin-case-agent-execution/submit"
    );
    const now = new Date("2026-07-26T12:00:00Z");
    expect(
      isStaleCaseAgentExecution({ updatedAt: "2026-07-26T11:30:00Z", phase: "COLLECTING" }, now)
    ).toBe(true);
  });

  it("исполнение без отметки времени считается застрявшим", async () => {
    // Без отметки нельзя сказать, живо ли оно; блокировать отправку навсегда хуже.
    const { isStaleCaseAgentExecution } = await import(
      "../../src/modules/digital-profile/services/arsenkin-case-agent-execution/submit"
    );
    expect(isStaleCaseAgentExecution({ updatedAt: null }, new Date())).toBe(true);
  });

  it("оркестратор просит автоматический дозапуск", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/services/unified-orion-collection-orchestrator.ts"),
      "utf8"
    );
    expect(src).toMatch(/reuseActiveExecution: true/u);
  });
});
