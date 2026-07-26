import { describe, expect, it } from "vitest";
import {
  EMPTY_PROGRESS_MARK,
  MAX_IDLE_POLLS,
  decideEnrichmentPoll,
  markEnrichmentProgress,
  pollBackoffMs,
  progressAdvanced,
  type EnrichmentProgressMark,
} from "../../src/modules/digital-profile/services/arsenkin-poll-budget";
import {
  NO_AUTO_RESUME,
  autoResumeState,
  recoveryNeedsUser,
} from "../../src/modules/digital-profile/workflow/auto-resume";
import type { WorkflowStepRow } from "../../src/modules/digital-profile/workflow/step-types";

/**
 * Шаг 14.
 *
 * Ручное тестирование: прогон падал с «Arsenkin durable poll exceeded 40
 * attempts» и предлагал начать заново, при том что в личном кабинете Arsenkin
 * задачи были отправлены и **выполнялись**. После нескольких нажатий кнопки
 * сбор доходил до конца сам.
 *
 * Бюджет считал не то: увеличивался на каждом опросе, включая те, где
 * провайдер честно работал. При потолке паузы в 30 секунд сорок опросов — это
 * около двадцати минут, ровно длина честного прогона. А помогала кнопка
 * потому, что ручное восстановление обнуляло счётчик, а автоматическое — нет.
 */

const mark = (over: Partial<EnrichmentProgressMark> = {}): EnrichmentProgressMark => ({
  ...EMPTY_PROGRESS_MARK,
  ...over,
});

const NOW = new Date("2026-07-26T12:00:00.000Z");

describe("замер продвижения", () => {
  it("считает терминальные и принятые агенты, задачи и наблюдения", () => {
    const state = {
      agents: [
        { terminal: true, ingested: true, doneTaskCount: 3 },
        { terminal: false, ingested: false, doneTaskCount: 1 },
      ],
      enrichmentObservationCount: 42,
    } as never;
    expect(markEnrichmentProgress(state)).toEqual({
      terminalAgents: 1,
      ingestedAgents: 1,
      doneTasks: 4,
      observations: 42,
      doneProviderTasks: 0,
      persistedObservations: 0,
    });
  });

  it("счёты из базы попадают в замер", () => {
    // На живом прогоне сводка джобы обновляется только на границах агентов:
    // пока первый из пяти работает, в ней всё по нулям. Строки задач при этом
    // переходят в DONE по одной, и именно они показывают, что провайдер жив.
    expect(
      markEnrichmentProgress(null, { doneProviderTasks: 2, persistedObservations: 137 })
    ).toMatchObject({ doneProviderTasks: 2, persistedObservations: 137 });
  });

  it("завершённая задача провайдера — это продвижение", () => {
    expect(
      progressAdvanced(mark({ doneProviderTasks: 1 }), mark({ doneProviderTasks: 2 }))
    ).toBe(true);
    expect(
      progressAdvanced(mark({ persistedObservations: 10 }), mark({ persistedObservations: 11 }))
    ).toBe(true);
  });

  it("замер старой формы читается как нули, а не ломает сравнение", () => {
    // В базе лежат замеры, записанные до появления новых счётов.
    const legacy = { terminalAgents: 0, ingestedAgents: 0, doneTasks: 0, observations: 0 };
    expect(progressAdvanced(legacy, mark({ doneProviderTasks: 1 }))).toBe(true);
    expect(progressAdvanced(legacy, mark())).toBe(false);
  });

  it("отсутствие состояния даёт пустой замер, а не падение", () => {
    expect(markEnrichmentProgress(null)).toEqual(EMPTY_PROGRESS_MARK);
    expect(markEnrichmentProgress(undefined)).toEqual(EMPTY_PROGRESS_MARK);
  });

  it("рост любого счётчика — продвижение", () => {
    const prev = mark({ doneTasks: 2, observations: 10 });
    expect(progressAdvanced(prev, mark({ doneTasks: 3, observations: 10 }))).toBe(true);
    expect(progressAdvanced(prev, mark({ doneTasks: 2, observations: 11 }))).toBe(true);
    expect(progressAdvanced(prev, mark({ doneTasks: 2, observations: 10, terminalAgents: 1 }))).toBe(
      true
    );
  });

  it("без изменений продвижения нет", () => {
    const prev = mark({ doneTasks: 2 });
    expect(progressAdvanced(prev, mark({ doneTasks: 2 }))).toBe(false);
  });

  it("первый замер продвижением не считается", () => {
    // Иначе перезапуск обнулял бы счётчик простоя, и застрявший прогон ждал бы
    // вечно, ни разу не исчерпав бюджет.
    expect(progressAdvanced(null, mark({ doneTasks: 5 }))).toBe(false);
  });
});

describe("ожидание не тратится, пока провайдер работает", () => {
  const decide = (over: Partial<Parameters<typeof decideEnrichmentPoll>[0]> = {}) =>
    decideEnrichmentPoll({
      previous: mark({ doneTasks: 2 }),
      current: mark({ doneTasks: 3 }),
      idlePolls: 10,
      waitStartedAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(),
      now: NOW,
      ...over,
    });

  it("продвижение обнуляет счётчик простоя", () => {
    // Тот самый случай: задачи выполняются, ждать можно и нужно.
    expect(decide()).toEqual({ kind: "wait", idlePolls: 0, advanced: true });
  });

  it("двадцать минут работы бюджет не исчерпывают", () => {
    // Прежний счётчик за это время дошёл бы до сорока и объявил отказ.
    let idlePolls = 0;
    let previous: EnrichmentProgressMark | null = null;
    for (let i = 1; i <= 60; i += 1) {
      const current = mark({ doneTasks: i });
      const d = decideEnrichmentPoll({
        previous,
        current,
        idlePolls,
        waitStartedAt: new Date(NOW.getTime() - 20 * 60_000).toISOString(),
        now: NOW,
      });
      expect(d.kind).toBe("wait");
      idlePolls = d.kind === "wait" ? d.idlePolls : idlePolls;
      previous = current;
    }
    expect(idlePolls).toBe(0);
  });

  it("без продвижения счётчик растёт", () => {
    const same = mark({ doneTasks: 3 });
    expect(decide({ previous: same, current: same, idlePolls: 4 })).toMatchObject({
      kind: "wait",
      idlePolls: 5,
      advanced: false,
    });
  });

  it("тишина сверх предела исчерпывает бюджет, и это повторяемо", () => {
    const same = mark({ doneTasks: 3 });
    const d = decide({ previous: same, current: same, idlePolls: MAX_IDLE_POLLS });
    expect(d).toMatchObject({ kind: "exhausted", retryable: true });
    expect(d.kind === "exhausted" && d.reason).toMatch(/не показывает продвижения/u);
  });

  it("исчерпанный общий срок повтором не лечится", () => {
    // Возобновление упрётся в тот же срок сразу же, поэтому кнопку не предлагаем.
    const d = decide({
      waitStartedAt: new Date(NOW.getTime() - 5 * 60 * 60_000).toISOString(),
    });
    expect(d).toMatchObject({ kind: "exhausted", retryable: false });
    expect(d.kind === "exhausted" && d.reason).toMatch(/не завершилось за/u);
  });

  it("общий срок перевешивает продвижение", () => {
    // Иначе бесконечно медленный провайдер держал бы прогон вечно.
    expect(
      decide({ waitStartedAt: new Date(NOW.getTime() - 5 * 60 * 60_000).toISOString() }).kind
    ).toBe("exhausted");
  });

  it("неизвестное начало ожидания срок не исчерпывает", () => {
    expect(decide({ waitStartedAt: null }).kind).toBe("wait");
    expect(decide({ waitStartedAt: "не дата" }).kind).toBe("wait");
  });
});

describe("пауза между опросами", () => {
  it("при продвижении остаётся короткой", () => {
    expect(pollBackoffMs(0)).toBe(5_000);
  });

  it("при простое растёт до потолка", () => {
    expect(pollBackoffMs(1)).toBe(2_000);
    expect(pollBackoffMs(3)).toBe(8_000);
    expect(pollBackoffMs(40)).toBe(30_000);
  });
});

describe("кнопка нужна только там, где без неё не сдвинется", () => {
  const step = (over: Partial<WorkflowStepRow> = {}): WorkflowStepRow =>
    ({
      id: "s1",
      caseId: "c1",
      jobId: "j1",
      name: "ARSENKIN_ENRICHMENT",
      position: 2,
      state: "WAITING",
      attempts: 3,
      maxAttempts: 40,
      nextRunAt: new Date(NOW.getTime() + 30_000),
      leaseOwner: null,
      leaseUntil: null,
      inputHash: null,
      outputRef: null,
      lastError: null,
      lastErrorCode: null,
      ...over,
    }) as WorkflowStepRow;

  it("шаг со сроком и бюджетом продолжится сам", () => {
    expect(autoResumeState([step()], NOW)).toMatchObject({
      pending: true,
      stepName: "ARSENKIN_ENRICHMENT",
    });
  });

  it("упавший шаг с запланированным повтором тоже продолжится сам", () => {
    expect(autoResumeState([step({ state: "FAILED" })], NOW).pending).toBe(true);
  });

  it("исчерпанный бюджет попыток сам не продолжится", () => {
    expect(autoResumeState([step({ attempts: 40 })], NOW)).toEqual(NO_AUTO_RESUME);
  });

  it("шаг без срока сам не продолжится", () => {
    expect(autoResumeState([step({ nextRunAt: null })], NOW)).toEqual(NO_AUTO_RESUME);
  });

  it("идущий шаг — это не «вернётся», а «идёт»", () => {
    expect(autoResumeState([step({ state: "RUNNING" })], NOW)).toEqual(NO_AUTO_RESUME);
  });

  it("срок в прошлом показывается как «сейчас», а не как прошедшее время", () => {
    const past = autoResumeState([step({ nextRunAt: new Date(NOW.getTime() - 60_000) })], NOW);
    expect(past.resumeAt).toBe(NOW.toISOString());
  });

  it("берётся ближайший срок из нескольких шагов", () => {
    const state = autoResumeState(
      [
        step({ id: "a", name: "COMPOSITE_MERGE", nextRunAt: new Date(NOW.getTime() + 90_000) }),
        step({ id: "b", name: "ARSENKIN_ENRICHMENT", nextRunAt: new Date(NOW.getTime() + 10_000) }),
      ],
      NOW
    );
    expect(state.stepName).toBe("ARSENKIN_ENRICHMENT");
  });

  it("пока продолжение запланировано, пользователя не зовут", () => {
    expect(
      recoveryNeedsUser({ recoveryAllowed: true, autoResume: autoResumeState([step()], NOW) })
    ).toBe(false);
  });

  it("когда само не сдвинется — зовут", () => {
    expect(recoveryNeedsUser({ recoveryAllowed: true, autoResume: NO_AUTO_RESUME })).toBe(true);
  });

  it("без права на восстановление кнопки нет в любом случае", () => {
    expect(recoveryNeedsUser({ recoveryAllowed: false, autoResume: NO_AUTO_RESUME })).toBe(false);
  });
});
