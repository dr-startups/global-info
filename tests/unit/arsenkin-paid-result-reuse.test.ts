import { describe, expect, it } from "vitest";
import { createMemoryProviderTaskStore } from "../../src/modules/digital-profile/providers/arsenkin/provider-task-store";
import { ensureArsenkinTask } from "../../src/modules/digital-profile/providers/arsenkin/poll-worker";

/**
 * Один и тот же запрос не оплачивается дважды.
 *
 * Заказчик увидел в личном кабинете Arsenkin, что почти каждый инструмент
 * выполнился по два-три раза. Замер по базе подтвердил: 6 задач `ai-serp` на
 * **3** различных хеша запроса, 6 задач `suggest` на 3 хеша, 6 задач
 * `check-top` на 4 — то есть задач больше, чем запросов.
 *
 * Причина: дедупликация искала по паре «прогон + хеш»
 * (`findByRequestHash(reportRunId, hash)`), а прогон агента заводится заново при
 * каждом дозапуске. Тот же запрос под новым прогоном — новая строка и новый
 * платный `/set`.
 */

const REQUEST = { toolName: "suggest", data: { queries: ["Иванов Иван"], se: 1 } };

/**
 * Клиент, до которого доходить нельзя: любое обращение к нему — платный вызов.
 * Считаем обращения, а не ловим бросок: строка может дойти до отправки и позже.
 */
function countingClient(): { calls: number } {
  const state = { calls: 0 };
  return new Proxy(state as never, {
    get(target, prop) {
      if (prop === "calls") return state.calls;
      return () => {
        state.calls += 1;
        throw new Error(`платный вызов Arsenkin: ${String(prop)}`);
      };
    },
  });
}

/** Переиспользование состоялось: строка уже готова и ничего не стоила. */
const reused = (row: { state: string; limitsSpent?: number | null }): boolean =>
  row.state === "DONE" && (row.limitsSpent ?? 0) === 0;

describe("оплаченный ответ переиспользуется между прогонами одного сбора", () => {
  it("второй прогон не платит за тот же запрос", async () => {
    const store = createMemoryProviderTaskStore();
    // Первый прогон: задача выполнена и оплачена.
    const first = await store.upsertPending({
      caseId: "case-1",
      reportRunId: "run-1",
      toolName: REQUEST.toolName,
      requestJson: { tools_name: REQUEST.toolName, data: REQUEST.data },
    });
    await store.claimForSubmission(first.id, "test", 60_000);
    await store.markExternalId(first.id, "30700001");
    await store.updateState(first.id, {
      state: "DONE",
      responseJson: { result: { suggestions: ["иванов иван биография"] } },
      limitsSpent: 1,
      completedAt: new Date(),
    });

    const client = countingClient();
    const row = await ensureArsenkinTask(client as never, store, {
      ...REQUEST,
      caseId: "case-1",
      reportRunId: "run-2",
      reuseFromRunIds: ["run-1"],
    });

    // Ни одного обращения к провайдеру.
    expect(client.calls).toBe(0);
    expect(row.state).toBe("DONE");
    expect(row.reportRunId).toBe("run-2");
    // Нагрузка та же, внешний идентификатор сохранён — трасса не теряется.
    expect(row.responseJson).toEqual(first.responseJson ?? row.responseJson);
    expect(row.externalTaskId).toBe("30700001");
    // За неё уже заплатили в соседнем прогоне.
    expect(row.limitsSpent).toBe(0);
  });

  it("без соседних прогонов поведение прежнее", async () => {
    const store = createMemoryProviderTaskStore();
    const client = countingClient();
    // Переиспользовать нечего — строка уходит в обычный путь отправки.
    const row = await ensureArsenkinTask(client as never, store, {
      ...REQUEST,
      caseId: "case-1",
      reportRunId: "run-1",
    }).catch(() => null);
    expect(row === null || !reused(row)).toBe(true);
  });

  it("незавершённая задача соседа не переиспользуется", async () => {
    const store = createMemoryProviderTaskStore();
    await store.upsertPending({
      caseId: "case-1",
      reportRunId: "run-1",
      toolName: REQUEST.toolName,
      requestJson: { tools_name: REQUEST.toolName, data: REQUEST.data },
    });
    const client = countingClient();
    // Чем кончится соседняя задача — неизвестно, поэтому ждать её нельзя.
    const row = await ensureArsenkinTask(client as never, store, {
      ...REQUEST,
      caseId: "case-1",
      reportRunId: "run-2",
      reuseFromRunIds: ["run-1"],
    }).catch(() => null);
    expect(row === null || !reused(row)).toBe(true);
  });

  it("другой запрос переиспользованию не подлежит", async () => {
    const store = createMemoryProviderTaskStore();
    const other = await store.upsertPending({
      caseId: "case-1",
      reportRunId: "run-1",
      toolName: "suggest",
      requestJson: { tools_name: "suggest", data: { queries: ["Петров"], se: 1 } },
    });
    await store.updateState(other.id, {
      state: "DONE",
      responseJson: { result: {} },
      completedAt: new Date(),
    });
    const client = countingClient();
    const row = await ensureArsenkinTask(client as never, store, {
      ...REQUEST,
      caseId: "case-1",
      reportRunId: "run-2",
      reuseFromRunIds: ["run-1"],
    }).catch(() => null);
    expect(row === null || !reused(row)).toBe(true);
  });
});
