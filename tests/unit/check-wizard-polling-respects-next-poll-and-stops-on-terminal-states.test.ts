import { describe, expect, it } from "vitest";
import {
  MIN_POLL_MS,
  createStatusPoller,
  pollDelay,
  type PollStatus,
} from "@/modules/site/check/polling";

/**
 * Опрос статуса делит процесс с платными прогонами: воркер живёт в том же
 * контейнере, что и сайт. Поэтому срок опроса задаёт сервер, чаще раза в пять
 * секунд страница не спрашивает, закончившаяся проверка не спрашивается вовсе, а
 * вкладка, которую никто не видит, не спрашивает, пока её не откроют.
 */

const running = (nextPollMs?: number): PollStatus => ({
  status: "RUNNING",
  run: nextPollMs === undefined ? null : { nextPollMs },
});
const final = (status: string): PollStatus => ({ status, run: null });

describe("срок опроса", () => {
  it("идущий прогон — срок сервера", () => {
    expect(pollDelay(running(7000))).toBe(7000);
  });

  it("чаще раза в пять секунд — нет, даже если сервер попросил", () => {
    expect(MIN_POLL_MS).toBe(5000);
    expect(pollDelay(running(1000))).toBe(5000);
    expect(pollDelay(running(Number.NaN))).toBe(5000);
    expect(pollDelay(running())).toBe(5000);
  });

  it.each(["DONE", "FAILED", "BLOCKED", "EXPIRED", "CREATED", "PERSONA_PENDING", "PERSONA_DECIDED"])(
    "%s не опрашивается",
    (s) => {
      expect(pollDelay(final(s))).toBeNull();
    }
  );

  it("без статуса опроса нет", () => {
    expect(pollDelay(null)).toBeNull();
  });
});

type Timer = { fn: () => void; ms: number; cleared: boolean; fired: boolean };

function rig(answers: Array<PollStatus | "retry" | null>) {
  const timers: Timer[] = [];
  const seen: PollStatus[] = [];
  const state = { visible: true, loads: 0 };
  const poller = createStatusPoller({
    load: async () => {
      state.loads += 1;
      return answers.length > 0 ? answers.shift()! : null;
    },
    onStatus: (s) => seen.push(s),
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, cleared: false, fired: false });
      return timers.length - 1;
    },
    clearTimer: (handle) => {
      timers[handle as number]!.cleared = true;
    },
    isVisible: () => state.visible,
  });
  const pending = () => timers.filter((t) => !t.cleared && !t.fired);
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const fire = async () => {
    const [timer] = pending();
    if (!timer) throw new Error("таймера нет");
    timer.fired = true;
    timer.fn();
    await settle();
  };
  return { poller, timers, seen, state, pending, fire, settle };
}

describe("опрос", () => {
  it("идущий прогон спрашивается по сроку сервера, и срок берётся из свежего ответа", async () => {
    const r = rig([running(9000)]);
    r.poller.start(running(7000));
    expect(r.state.loads).toBe(0);
    expect(r.pending().map((t) => t.ms)).toEqual([7000]);
    await r.fire();
    expect(r.state.loads).toBe(1);
    expect(r.seen).toEqual([running(9000)]);
    expect(r.pending().map((t) => t.ms)).toEqual([9000]);
  });

  it("конечный статус останавливает опрос", async () => {
    const r = rig([final("DONE")]);
    r.poller.start(running(7000));
    await r.fire();
    expect(r.seen).toEqual([final("DONE")]);
    expect(r.pending()).toHaveLength(0);
  });

  it("закончившаяся проверка опрос не начинает", () => {
    const r = rig([]);
    r.poller.start(final("FAILED"));
    expect(r.pending()).toHaveLength(0);
  });

  it("скрытая вкладка гасит таймер, возврат сразу спрашивает статус", async () => {
    const r = rig([running(7000)]);
    r.poller.start(running(7000));
    r.state.visible = false;
    r.poller.visibilityChanged();
    expect(r.pending()).toHaveLength(0);
    expect(r.state.loads).toBe(0);

    r.state.visible = true;
    r.poller.visibilityChanged();
    await r.settle();
    expect(r.state.loads).toBe(1);
    expect(r.pending().map((t) => t.ms)).toEqual([7000]);
  });

  it("запуск в скрытой вкладке ждёт, пока её откроют", async () => {
    const r = rig([final("DONE")]);
    r.state.visible = false;
    r.poller.start(running(7000));
    expect(r.pending()).toHaveLength(0);
    r.state.visible = true;
    r.poller.visibilityChanged();
    await r.settle();
    expect(r.state.loads).toBe(1);
    expect(r.seen).toEqual([final("DONE")]);
  });

  it("возврат во вкладку с таймером в пути лишнего запроса не делает", async () => {
    const r = rig([]);
    r.poller.start(running(7000));
    r.poller.visibilityChanged();
    await r.settle();
    expect(r.state.loads).toBe(0);
    expect(r.pending()).toHaveLength(1);
  });

  it("возврат к закончившейся проверке её не спрашивает", async () => {
    const r = rig([final("DONE")]);
    r.poller.start(running(7000));
    await r.fire();
    r.state.visible = false;
    r.poller.visibilityChanged();
    r.state.visible = true;
    r.poller.visibilityChanged();
    await r.settle();
    expect(r.state.loads).toBe(1);
  });

  it("сетевой сбой — повтор через нижний срок; отказ ручки — остановка", async () => {
    const r = rig(["retry", null]);
    r.poller.start(running(9000));
    await r.fire();
    expect(r.pending().map((t) => t.ms)).toEqual([5000]);
    await r.fire();
    expect(r.state.loads).toBe(2);
    expect(r.pending()).toHaveLength(0);
    expect(r.seen).toEqual([]);
  });

  it("остановка при уходе со страницы гасит таймер и не принимает ответ в пути", async () => {
    const r = rig([running(7000)]);
    r.poller.start(running(7000));
    r.poller.stop();
    expect(r.pending()).toHaveLength(0);

    const s = rig([running(7000)]);
    s.poller.start(running(7000));
    const [timer] = s.pending();
    timer!.fired = true;
    timer!.fn();
    s.poller.stop();
    await s.settle();
    expect(s.seen).toEqual([]);
    expect(s.pending()).toHaveLength(0);
    s.poller.visibilityChanged();
    await s.settle();
    expect(s.state.loads).toBe(1);
  });
});
