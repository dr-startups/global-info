import { describe, expect, it } from "vitest";
import { createMemoryProviderTaskStore } from "../../src/modules/digital-profile/providers/arsenkin/provider-task-store";
import {
  pollArsenkinTask,
  runDueArsenkinPolls,
  taskPollBackoffMs,
} from "../../src/modules/digital-profile/providers/arsenkin/poll-worker";

/**
 * Задача, поставленная провайдером в очередь, обязана опрашиваться дальше.
 *
 * Заказчик получил в UI «Arsenkin не показывает продвижения 41 опросов подряд»
 * при том, что в личном кабинете Arsenkin задачи были отправлены, различны и
 * отрабатывали. То есть провайдер работал, а наша сторона завершения не видела.
 *
 * Причина — одно слово в двух смыслах. `QUEUED` означало сразу и «строка
 * заведена у нас, в Arsenkin ещё не отправлена», и «Arsenkin принял и поставил в
 * свою очередь» (у API есть очередь на 50 задач при 5 одновременных). Опрос
 * пропускал `QUEUED`, считая её неотправленной, — и стоило `/check` один раз
 * ответить «в очереди», задача переставала опрашиваться навсегда:
 *
 *   - `pollArsenkinTask` выходил по раннему возврату;
 *   - `waitForArsenkinTaskCompletion` уходил в `ensureArsenkinTask`, а тот
 *     возвращал строку как есть, раз внешний идентификатор уже присвоен;
 *   - `runDueArsenkinPolls` звал тот же `pollArsenkinTask`.
 *
 * Ни одна задача не доходила до `DONE`, счётчик простоя добирал до потолка, и
 * пользователю предлагали платный пересбор.
 *
 * Правило, которое здесь проверяется, опирается на данные, а не на название:
 * **есть внешний идентификатор — строку можно и нужно опрашивать**. Нет его —
 * опрашивать нечего.
 */

const EXTERNAL_ID = "30700042";

/** Ответы `/check` по очереди; `/get` отдаёт нагрузку. */
function scriptedClient(checkPayloads: Record<string, unknown>[]) {
  const calls = { check: 0, get: 0 };
  return {
    calls,
    async checkTask() {
      const raw = checkPayloads[Math.min(calls.check, checkPayloads.length - 1)];
      calls.check += 1;
      const status = String(
        (raw as { status?: unknown; state?: unknown; code?: unknown }).status ??
          (raw as { state?: unknown }).state ??
          (raw as { code?: unknown }).code ??
          ""
      ).toLowerCase();
      const state = status.includes("queue")
        ? "QUEUED"
        : status.includes("result") || status.includes("done")
          ? "DONE"
          : "RUNNING";
      return { task_id: EXTERNAL_ID, state, statusPayload: raw, raw };
    },
    async getTask() {
      calls.get += 1;
      return {
        task_id: EXTERNAL_ID,
        code: "TASK_RESULT",
        result: { suggestions: ["иванов иван биография"] },
        raw: { code: "TASK_RESULT", result: { suggestions: ["иванов иван биография"] } },
      };
    },
    async getLimits() {
      return { limitsTotal: 100, limitsSpent: 1, limitsLeft: 99, raw: {} };
    },
  };
}

/** Отправленная строка: внешний идентификатор присвоен, опрос разрешён. */
async function submittedRow(store: ReturnType<typeof createMemoryProviderTaskStore>) {
  const row = await store.upsertPending({
    caseId: "case-1",
    reportRunId: "run-1",
    toolName: "suggest",
    requestJson: { tools_name: "suggest", data: { queries: ["Иванов Иван"], se: 1 } },
  });
  await store.claimForSubmission(row.id, "test", 60_000);
  await store.markExternalId(row.id, EXTERNAL_ID);
  return store.updateState(row.id, {
    state: "RUNNING",
    submittedAt: new Date(),
    nextPollAt: new Date(Date.now() - 1),
    // Отправка отработала и аренду отпустила — как в рабочем пути.
    lockedBy: null,
    lockedAt: null,
    leaseUntil: null,
  });
}

describe("очередь на стороне Arsenkin не останавливает опрос", () => {
  it("после ответа «в очереди» задача опрашивается снова и доходит до DONE", async () => {
    const store = createMemoryProviderTaskStore();
    const row = await submittedRow(store);
    // Сначала провайдер держит задачу в очереди, затем отдаёт результат.
    const client = scriptedClient([{ code: "TASK_QUEUE" }, { code: "TASK_RESULT" }]);

    const queued = await pollArsenkinTask(client as never, store, row);
    // Ответ провайдера принят, но строка обязана остаться опрашиваемой.
    expect(queued.externalTaskId).toBe(EXTERNAL_ID);
    expect(queued.state).not.toBe("DONE");

    const next = await store.findById(queued.id);
    expect(next?.nextPollAt, "следующий опрос должен быть запланирован").not.toBeNull();

    // Второй опрос — тот самый, которого раньше не происходило.
    const done = await pollArsenkinTask(client as never, store, { ...queued, nextPollAt: null });
    expect(client.calls.check, "провайдер должен быть опрошен дважды").toBe(2);
    expect(done.state).toBe("DONE");
    expect(done.responseJson).toBeTruthy();
  });

  it("фоновый обход тоже забирает задачу из очереди провайдера", async () => {
    const store = createMemoryProviderTaskStore();
    const row = await submittedRow(store);
    const client = scriptedClient([{ code: "TASK_QUEUE" }, { code: "TASK_RESULT" }]);

    const queued = await pollArsenkinTask(client as never, store, row);
    // Ответ «в очереди» не должен выводить строку из-под фонового обхода.
    await store.updateState(row.id, { state: queued.state, nextPollAt: new Date(Date.now() - 1) });

    const polled = await runDueArsenkinPolls(client as never, store, { limit: 10 });
    expect(polled.map((r) => r.state)).toContain("DONE");
  });

  it("частота опроса умещается в бюджет аккаунта", () => {
    // 30 запросов в минуту — на весь аккаунт и на все обращения сразу
    // (`/set`, `/check`, `/get`, `/info`); держим 24. Прежние неизменные две
    // секунды — это 30 запросов в минуту на одну задачу, то есть весь бюджет
    // на неё одну, а отправкам не остаётся ничего.
    expect(taskPollBackoffMs(1)).toBeGreaterThanOrEqual(5_000);
    // Пауза растёт и упирается в потолок.
    expect(taskPollBackoffMs(2)).toBeGreaterThan(taskPollBackoffMs(1));
    expect(taskPollBackoffMs(50)).toBe(30_000);

    // Десять задач в работе не должны просить больше, чем аккаунт может дать.
    const perMinuteAtCeiling = (60_000 / taskPollBackoffMs(50)) * 10;
    expect(perMinuteAtCeiling).toBeLessThanOrEqual(24);
  });

  it("опрос переносится на назначенное время, а не на две секунды", async () => {
    const store = createMemoryProviderTaskStore();
    const row = await submittedRow(store);
    const client = scriptedClient([{ code: "TASK_QUEUE" }]);
    const polled = await pollArsenkinTask(client as never, store, row);
    const dueInMs = (polled.nextPollAt?.getTime() ?? 0) - Date.now();
    expect(dueInMs).toBeGreaterThan(2_000);
  });

  it("строка без внешнего идентификатора не опрашивается", async () => {
    const store = createMemoryProviderTaskStore();
    // Это настоящий «ещё не отправлено»: опрашивать в Arsenkin нечего.
    const row = await store.upsertPending({
      caseId: "case-1",
      reportRunId: "run-1",
      toolName: "suggest",
      requestJson: { tools_name: "suggest", data: { queries: ["Иванов"], se: 1 } },
    });
    const client = scriptedClient([{ code: "TASK_RESULT" }]);
    await pollArsenkinTask(client as never, store, row);
    expect(client.calls.check, "провайдера дёргать нечем").toBe(0);
  });
});
