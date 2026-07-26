/**
 * Бюджет ожидания Arsenkin (шаг 14).
 *
 * Наблюдение с ручного тестирования: прогон падал с «Arsenkin durable poll
 * exceeded 40 attempts», предлагая начать заново, — при том что в личном
 * кабинете Arsenkin все задачи были отправлены и часть **выполнялась**. После
 * нескольких нажатий кнопки сбор доходил до конца сам.
 *
 * Причина в том, что бюджет считал не то. `pollAttempt` увеличивался на
 * **каждом** опросе, включая те, где провайдер честно работал. При потолке
 * паузы в 30 секунд сорок опросов — это около двадцати минут, а полный прогон
 * пяти агентов по всем поверхностям столько и идёт. То есть бюджет попыток
 * работал как таймер и срабатывал на здоровом прогоне — ровно та же ошибка,
 * что A2 из шага 13, только во второй, отдельной реализации.
 *
 * Почему помогала кнопка: ручное восстановление обнуляло `pollAttempt`, а
 * автоматическое возобновление — нет. Каждое нажатие покупало ещё двадцать
 * минут, и оркестрация оказывалась на пользователе.
 *
 * Здесь бюджет измеряет то, что должен: **сколько опросов подряд прошло без
 * продвижения**. Пока задачи двигаются, ожидание не тратится. Сверху — общий
 * срок ожидания, чтобы застрявший провайдер не держал прогон бесконечно.
 *
 * Модуль чистый: ни сети, ни БД, ни времени изнутри.
 */

import type { ArsenkinEnrichmentState } from "./arsenkin-enrichment-state";

/**
 * Снимок продвижения обогащения.
 *
 * Всё, что здесь считается, растёт монотонно, пока провайдер работает: агент
 * дошёл до терминального состояния, результат принят, задача выполнена,
 * наблюдений стало больше. Любой сдвиг — признак живого прогона.
 */
export type EnrichmentProgressMark = {
  terminalAgents: number;
  ingestedAgents: number;
  doneTasks: number;
  observations: number;
  /**
   * Задачи провайдера, дошедшие до `DONE`, и сохранённые наблюдения.
   *
   * Эти два счёта берутся из строк в базе, а не из сводного состояния джобы.
   * На живом прогоне выяснилось, что сводка обновляется только на границах
   * агентов: пять агентов идут по очереди, и пока первый работает, в сводке
   * всё по нулям — то есть сигнал продвижения, выведенный только из неё,
   * молчит там, где провайдер работает. Строки задач при этом переходят в
   * `DONE` по одной.
   */
  doneProviderTasks: number;
  persistedObservations: number;
};

export const EMPTY_PROGRESS_MARK: EnrichmentProgressMark = {
  terminalAgents: 0,
  ingestedAgents: 0,
  doneTasks: 0,
  observations: 0,
  doneProviderTasks: 0,
  persistedObservations: 0,
};

export function markEnrichmentProgress(
  state: ArsenkinEnrichmentState | null | undefined,
  /** Счёты из базы: они двигаются внутри агента, а сводка — только на границах. */
  live: { doneProviderTasks?: number; persistedObservations?: number } = {}
): EnrichmentProgressMark {
  const agents = state?.agents ?? [];
  return {
    terminalAgents: agents.filter((a) => a.terminal).length,
    ingestedAgents: agents.filter((a) => a.ingested).length,
    doneTasks: agents.reduce((sum, a) => sum + Math.max(0, Number(a.doneTaskCount ?? 0)), 0),
    observations: Math.max(0, Number(state?.enrichmentObservationCount ?? 0)),
    doneProviderTasks: Math.max(0, Number(live.doneProviderTasks ?? 0)),
    persistedObservations: Math.max(0, Number(live.persistedObservations ?? 0)),
  };
}

/**
 * Сдвинулось ли обогащение между двумя замерами.
 *
 * Первый замер продвижением не считается: иначе любой перезапуск обнулял бы
 * счётчик простоя и застрявший прогон ждал бы вечно.
 */
export function progressAdvanced(
  previous: Partial<EnrichmentProgressMark> | null | undefined,
  current: EnrichmentProgressMark
): boolean {
  if (!previous) return false;
  // Замер прошлого опроса мог быть записан до появления нового счёта —
  // отсутствующее поле читается как ноль, то есть «сведений не было».
  const before = { ...EMPTY_PROGRESS_MARK, ...previous };
  return (
    current.terminalAgents > before.terminalAgents ||
    current.ingestedAgents > before.ingestedAgents ||
    current.doneTasks > before.doneTasks ||
    current.observations > before.observations ||
    current.doneProviderTasks > before.doneProviderTasks ||
    current.persistedObservations > before.persistedObservations
  );
}

/**
 * Сколько опросов подряд без единого сдвига считаем застоем.
 *
 * При потолке паузы в 30 секунд это около двадцати минут полной тишины со
 * стороны провайдера — то есть уже не «долго считает», а «не отвечает».
 */
export const MAX_IDLE_POLLS = 40;

/**
 * Общий срок ожидания обогащения, включая автоматические возобновления.
 *
 * Наблюдённый полный прогон — около двадцати минут; четыре часа заведомо
 * больше любого честного и при этом ограничивают худший случай. Отсчёт не
 * сбрасывается при автоматическом возобновлении: иначе ограничения не было бы
 * вовсе — ровно та дыра, из-за которой ручные нажатия продлевали прогон
 * бесконечно.
 */
export const MAX_ENRICHMENT_WAIT_MS = 4 * 60 * 60 * 1000;

export type PollBudgetDecision =
  /** Ждём дальше; `idlePolls` — новое значение счётчика простоя. */
  | { kind: "wait"; idlePolls: number; advanced: boolean }
  /**
   * Ждать больше нельзя. `retryable` различает два случая: застой может быть
   * временным сбоем провайдера, а исчерпанный общий срок повтором не лечится —
   * возобновление упрётся в него сразу же.
   */
  | { kind: "exhausted"; reason: string; retryable: boolean; idlePolls: number };

export function decideEnrichmentPoll(input: {
  previous: Partial<EnrichmentProgressMark> | null | undefined;
  current: EnrichmentProgressMark;
  /** Счётчик простоя перед этим опросом. */
  idlePolls: number;
  /** Когда началось ожидание обогащения (ISO); `null` — отсчёт начинается сейчас. */
  waitStartedAt: string | null | undefined;
  now: Date;
  maxIdlePolls?: number;
  maxWaitMs?: number;
}): PollBudgetDecision {
  const maxIdle = input.maxIdlePolls ?? MAX_IDLE_POLLS;
  const maxWait = input.maxWaitMs ?? MAX_ENRICHMENT_WAIT_MS;
  const advanced = progressAdvanced(input.previous, input.current);
  const idlePolls = advanced ? 0 : Math.max(0, Number(input.idlePolls ?? 0)) + 1;

  const startedMs = input.waitStartedAt ? Date.parse(input.waitStartedAt) : Number.NaN;
  const waitedMs = Number.isFinite(startedMs) ? input.now.getTime() - startedMs : 0;
  if (waitedMs > maxWait) {
    return {
      kind: "exhausted",
      reason:
        `Обогащение Arsenkin не завершилось за ${Math.round(maxWait / 60000)} минут ` +
        `(прошло ${Math.round(waitedMs / 60000)}). Повтор упрётся в тот же срок.`,
      retryable: false,
      idlePolls,
    };
  }

  if (idlePolls > maxIdle) {
    return {
      kind: "exhausted",
      reason:
        `Arsenkin не показывает продвижения ${idlePolls} опросов подряд: ` +
        "ни одна задача не завершилась и новых наблюдений не появилось.",
      retryable: true,
      idlePolls,
    };
  }

  return { kind: "wait", idlePolls, advanced };
}

/**
 * Пауза до следующего опроса.
 *
 * Пока идёт продвижение, опрашивать часто незачем и вредно — это лишняя
 * нагрузка на провайдера, — но и растягивать паузу не нужно: работа идёт.
 * Растёт пауза только при простое.
 */
export function pollBackoffMs(idlePolls: number): number {
  const idle = Math.max(0, Number(idlePolls ?? 0));
  if (idle === 0) return 5_000;
  return Math.min(30_000, Math.max(2_000, 2_000 * 2 ** Math.min(idle - 1, 4)));
}
