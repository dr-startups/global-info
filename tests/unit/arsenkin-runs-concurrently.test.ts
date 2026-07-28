/**
 * Одновременность обращений к Arsenkin.
 *
 * Проверяем свойство, а не устройство: сколько работы идёт одновременно и что
 * ограничивает это число. Прежде оно равнялось единице в двух местах сразу —
 * очередь на весь процесс для агентов и последовательный цикл внутри плана, —
 * и живой прогон занимал около двадцати минут при пяти допустимых задачах.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  withArsenkinTaskSlot,
  withArsenkinSubmitSlot,
  activeArsenkinTaskSlots,
  activeArsenkinSubmitSlots,
  resetArsenkinTaskSlotsForTest,
} from "../../src/modules/digital-profile/providers/arsenkin/task-slots";
import { enqueueCaseAgentWork } from "../../src/modules/digital-profile/services/arsenkin-case-agent-execution/shared";

const ORIGINAL = process.env.ARSENKIN_MAX_CONCURRENT;

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Даёт микрозадачам и таймерам провернуться, не завися от реального времени. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
  await new Promise<void>((r) => setTimeout(r, 0));
}

describe("слоты задач Arsenkin", () => {
  beforeEach(() => {
    resetArsenkinTaskSlotsForTest();
  });

  afterEach(() => {
    resetArsenkinTaskSlotsForTest();
    if (ORIGINAL === undefined) delete process.env.ARSENKIN_MAX_CONCURRENT;
    else process.env.ARSENKIN_MAX_CONCURRENT = ORIGINAL;
  });

  it("пускает несколько задач одновременно, а не одну", async () => {
    process.env.ARSENKIN_MAX_CONCURRENT = "4";
    const gates = Array.from({ length: 6 }, () => deferred());
    const started: number[] = [];

    const all = gates.map((g, i) =>
      withArsenkinTaskSlot(async () => {
        started.push(i);
        await g.promise;
      })
    );

    await settle();
    expect(started.length).toBeGreaterThan(1);
    expect(activeArsenkinTaskSlots()).toBe(4);

    for (const g of gates) g.resolve();
    await Promise.all(all);
    expect(activeArsenkinTaskSlots()).toBe(0);
  });

  it("держит потолок одновременности из настройки аккаунта", async () => {
    process.env.ARSENKIN_MAX_CONCURRENT = "2";
    const gates = Array.from({ length: 5 }, () => deferred());
    let peak = 0;

    const all = gates.map((g) =>
      withArsenkinTaskSlot(async () => {
        peak = Math.max(peak, activeArsenkinTaskSlots());
        await g.promise;
      })
    );

    await settle();
    expect(activeArsenkinTaskSlots()).toBe(2);

    // Освобождение слота пускает следующего в очереди — и не больше одного.
    gates[0]!.resolve();
    await settle();
    expect(activeArsenkinTaskSlots()).toBe(2);

    for (const g of gates) g.resolve();
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(activeArsenkinTaskSlots()).toBe(0);
  });

  it("освобождает слот и после отказа", async () => {
    process.env.ARSENKIN_MAX_CONCURRENT = "1";
    await expect(
      withArsenkinTaskSlot(async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(activeArsenkinTaskSlots()).toBe(0);

    // Следующий вызов не должен ждать вечно освободившийся слот.
    await expect(withArsenkinTaskSlot(async () => "ok")).resolves.toBe("ok");
  });
});

describe("постановка задач Arsenkin", () => {
  beforeEach(() => {
    resetArsenkinTaskSlotsForTest();
  });

  it("идёт по одной, даже когда ожидание параллельно", async () => {
    /*
     * Замер на боевом прогоне 28.07: четыре одновременных `/set` дали `429 Too
     * Many Requests` на все четыре, повторы исчерпали бюджет попыток, и стадия
     * упала с `submit_retry_exhausted`. Выигрыша в параллельной постановке нет:
     * `/set` занимает 0,3–0,4 с при задаче в 45–105 с.
     */
    process.env.ARSENKIN_MAX_CONCURRENT = "4";
    const gates = Array.from({ length: 4 }, () => deferred());
    let peak = 0;

    const all = gates.map((g) =>
      // Ожидание идёт под слотом задачи, постановка — под слотом отправки.
      withArsenkinTaskSlot(async () => {
        await withArsenkinSubmitSlot(async () => {
          peak = Math.max(peak, activeArsenkinSubmitSlots());
          await g.promise;
        });
      })
    );

    await settle();
    // Все четыре задачи в работе, но отправка идёт одна.
    expect(activeArsenkinTaskSlots()).toBe(4);
    expect(activeArsenkinSubmitSlots()).toBe(1);

    for (const g of gates) g.resolve();
    await Promise.all(all);
    expect(peak).toBe(1);
    expect(activeArsenkinSubmitSlots()).toBe(0);
  });

  it("освобождает слот отправки после отказа провайдера", async () => {
    await expect(
      withArsenkinSubmitSlot(async () => {
        throw new Error("http_429");
      })
    ).rejects.toThrow("http_429");
    expect(activeArsenkinSubmitSlots()).toBe(0);
    await expect(withArsenkinSubmitSlot(async () => "ok")).resolves.toBe("ok");
  });
});

describe("очередь исполнений агента", () => {
  it("разные исполнения идут одновременно", async () => {
    const a = deferred();
    const b = deferred();
    const running: string[] = [];

    const first = enqueueCaseAgentWork("case-1/exec-a", async () => {
      running.push("a");
      await a.promise;
    });
    const second = enqueueCaseAgentWork("case-1/exec-b", async () => {
      running.push("b");
      await b.promise;
    });

    await settle();
    // Ключевое: второй агент не ждёт первого.
    expect(running).toEqual(["a", "b"]);

    a.resolve();
    b.resolve();
    await Promise.all([first, second]);
  });

  it("одно и то же исполнение дважды одновременно не идёт", async () => {
    const a = deferred();
    const order: string[] = [];

    const first = enqueueCaseAgentWork("case-1/exec-a", async () => {
      order.push("first-start");
      await a.promise;
      order.push("first-end");
    });
    const second = enqueueCaseAgentWork("case-1/exec-a", async () => {
      order.push("second-start");
    });

    await settle();
    expect(order).toEqual(["first-start"]);

    a.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("отказ одного исполнения не блокирует его же очередь", async () => {
    const failed = enqueueCaseAgentWork("case-2/exec-x", async () => {
      throw new Error("upstream");
    });
    await expect(failed).rejects.toThrow("upstream");

    await expect(
      enqueueCaseAgentWork("case-2/exec-x", async () => "next")
    ).resolves.toBe("next");
  });
});
