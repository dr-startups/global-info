import { describe, expect, it } from "vitest";
import {
  writeAgentRunStatus,
  type AgentRunStatusStore,
} from "../../src/modules/digital-profile/services/arsenkin-case-agent-execution/agent-run-status";

/**
 * Шаг 13, этап 5 (docs/rework/13-regression-run-findings.md, B6).
 *
 * Статус запуска агента писался через `update`, который бросает P2025, когда
 * записи нет. Запись законно может отсутствовать — прошлый запуск подчищен,
 * кейс удалён, — и журнал наполнялся трассами Prisma вокруг сообщений
 * «supersede old AgentRun failed». Настоящий сбой БД при этом терялся в шуме.
 */

function storeThatMatches(count: number): {
  store: AgentRunStatusStore;
  calls: Array<{ where: { id: string }; data: Record<string, unknown> }>;
} {
  const calls: Array<{ where: { id: string }; data: Record<string, unknown> }> = [];
  return {
    calls,
    store: {
      agentRun: {
        async updateMany(args) {
          calls.push({ where: args.where, data: args.data as Record<string, unknown> });
          return { count };
        },
      },
    },
  };
}

describe("запись статуса запуска агента", () => {
  it("обновляет запись и сообщает, что она нашлась", async () => {
    const { store, calls } = storeThatMatches(1);
    const ok = await writeAgentRunStatus({
      prisma: store,
      agentRunId: "run-1",
      data: { status: "SUCCEEDED", itemsSaved: 42 },
    });
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toEqual({ id: "run-1" });
    expect(calls[0].data).toMatchObject({ status: "SUCCEEDED", itemsSaved: 42 });
  });

  it("отсутствие записи ошибкой не считает", async () => {
    // Ровно случай B6: замещается запуск, которого в базе уже нет.
    const { store } = storeThatMatches(0);
    const ok = await writeAgentRunStatus({
      prisma: store,
      agentRunId: "run-gone",
      data: { status: "FAILED", error: "ARSENKIN_SUPERSEDED: заменён новым запуском" },
    });
    expect(ok).toBe(false);
  });

  it("пустой идентификатор в базу не ходит", async () => {
    const { store, calls } = storeThatMatches(1);
    const ok = await writeAgentRunStatus({ prisma: store, agentRunId: "", data: { status: "FAILED" } });
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("настоящий сбой базы пробрасывается наружу", async () => {
    // Тишина уместна только для «записи нет». Недоступная база — это ошибка,
    // и глушить её означало бы прятать поломку под видом гигиены журнала.
    const store: AgentRunStatusStore = {
      agentRun: {
        async updateMany() {
          throw new Error("connection terminated unexpectedly");
        },
      },
    };
    await expect(
      writeAgentRunStatus({ prisma: store, agentRunId: "run-1", data: { status: "FAILED" } })
    ).rejects.toThrow(/connection terminated/u);
  });
});
