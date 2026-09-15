/**
 * Опрос статуса страницей проверки.
 *
 * Опрос делит процесс с платными прогонами (воркер живёт в контейнере сайта),
 * поэтому срок задаёт сервер, чаще раза в пять секунд страница не спрашивает,
 * закончившаяся проверка не спрашивается, а скрытая вкладка ждёт, пока её
 * откроют. Таймеры и видимость приходят снаружи — так поведение проверяется без
 * браузера.
 */

export const MIN_POLL_MS = 5000;

export interface PollStatus {
  status: string;
  run: { nextPollMs?: number } | null;
}

/** Через сколько спросить снова; `null` — не спрашивать. */
export function pollDelay(status: PollStatus | null): number | null {
  if (!status || status.status !== "RUNNING") return null;
  const hint = Number(status.run?.nextPollMs);
  return Number.isFinite(hint) ? Math.max(hint, MIN_POLL_MS) : MIN_POLL_MS;
}

export interface StatusPollerDeps<S extends PollStatus> {
  /** Статус; `"retry"` — сетевой сбой, спросить позже; `null` — отказ ручки, опрос окончен. */
  load: () => Promise<S | "retry" | null>;
  onStatus: (status: S) => void;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  isVisible: () => boolean;
}

export interface StatusPoller<S extends PollStatus> {
  start: (status: S) => void;
  stop: () => void;
  visibilityChanged: () => void;
}

export function createStatusPoller<S extends PollStatus>(deps: StatusPollerDeps<S>): StatusPoller<S> {
  let last: S | null = null;
  let timer: unknown = null;
  let paused = false;
  let stopped = false;
  let inFlight = false;

  const clear = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
  };

  const arm = (ms: number) => {
    if (!deps.isVisible()) {
      paused = true;
      return;
    }
    timer = deps.setTimer(tick, ms);
  };

  const schedule = (status: S) => {
    clear();
    if (stopped) return;
    const delay = pollDelay(status);
    if (delay !== null) arm(delay);
  };

  async function tick() {
    timer = null;
    if (stopped) return;
    inFlight = true;
    let answer: S | "retry" | null;
    try {
      answer = await deps.load();
    } catch {
      answer = "retry";
    }
    inFlight = false;
    // Уход со страницы, пока ответ был в пути: ответ никому не нужен.
    if (stopped || answer === null) return;
    if (answer === "retry") {
      arm(MIN_POLL_MS);
      return;
    }
    last = answer;
    deps.onStatus(answer);
    schedule(answer);
  }

  return {
    start(status) {
      last = status;
      paused = false;
      schedule(status);
    },
    stop() {
      stopped = true;
      clear();
    },
    visibilityChanged() {
      if (stopped) return;
      if (!deps.isVisible()) {
        if (timer !== null) {
          clear();
          paused = true;
        }
        return;
      }
      // Вернулись во вкладку: статус мог давно смениться — спросить сразу, не
      // дожидаясь срока. Таймер в пути или закончившаяся проверка — ничего.
      if (!paused || inFlight) return;
      paused = false;
      if (pollDelay(last) !== null) void tick();
    },
  };
}
