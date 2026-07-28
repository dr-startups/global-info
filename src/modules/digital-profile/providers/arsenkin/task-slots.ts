/**
 * Сколько задач Arsenkin выполняется одновременно.
 *
 * Ограничитель аккаунта (`account-rate-limit.ts`) считает **обращения**: аренда
 * слота удерживается на время одного HTTP-вызова. Задача живёт не вызов, а
 * минуты — `/set`, затем `/check` до готовности, затем `/get`. Поэтому предел
 * «пять задач одновременно» тем ограничителем не выражается, и нужен второй
 * счёт — по задачам.
 *
 * Ответ на вопрос «сколько одновременно» при этом остаётся один: значение
 * берётся из той же настройки `ARSENKIN_MAX_CONCURRENT`, что и у ограничителя
 * обращений. Второго числа с собственным значением по умолчанию здесь нет
 * намеренно — именно так однажды разошлись 2 и 3 в двух копиях флагов.
 *
 * Область — процесс. Задачи Arsenkin создаёт воркер, и в нём этого достаточно;
 * веб-процесс живые отправки не делает, он опрашивает уже созданные. Если
 * отправки когда-нибудь появятся во втором процессе, счёт придётся вынести в
 * базу — как это сделано для обращений.
 */

import { arsenkinAccountLimiterConfig } from "./account-rate-limit";

type Gate = { active: number; waiting: Array<() => void> };

function makeGate(): Gate {
  return { active: 0, waiting: [] };
}

async function acquire(gate: Gate, capacity: number): Promise<void> {
  if (gate.active < capacity) {
    gate.active += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    gate.waiting.push(resolve);
  });
  gate.active += 1;
}

function release(gate: Gate): void {
  gate.active -= 1;
  const next = gate.waiting.shift();
  if (next) next();
}

async function withGate<T>(gate: Gate, capacity: number, fn: () => Promise<T>): Promise<T> {
  await acquire(gate, capacity);
  try {
    return await fn();
  } finally {
    release(gate);
  }
}

// --- ожидание задач -------------------------------------------------------

const tasks = makeGate();

function taskCapacity(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, arsenkinAccountLimiterConfig(env).maxConcurrent);
}

/** Занятые слоты задач — для проверок и диагностики. */
export function activeArsenkinTaskSlots(): number {
  return tasks.active;
}

/** Ожидающие слота задач — для проверок и диагностики. */
export function waitingArsenkinTaskSlots(): number {
  return tasks.waiting.length;
}

/**
 * Выполняет `fn`, заняв один слот задачи. Очередь — в порядке поступления.
 */
export async function withArsenkinTaskSlot<T>(fn: () => Promise<T>): Promise<T> {
  return withGate(tasks, taskCapacity(), fn);
}

// --- отправка задач -------------------------------------------------------

const submits = makeGate();

/**
 * Отправок одновременно — одна.
 *
 * Замер на боевом прогоне: `/set` занимает 0,3–0,4 с, а задача целиком —
 * 45–105 с. То есть в параллельной отправке выигрыша нет вовсе, а цена у неё
 * есть: при четырёх одновременных `/set` Arsenkin ответил `429 Too Many
 * Requests` на все, повторы исчерпали бюджет попыток, и стадия упала с
 * `submit_retry_exhausted`. Ограничитель аккаунта этого не поймал: он считает
 * запросы в минуту и одновременные обращения, а провайдер режет именно
 * одновременные постановки.
 *
 * Параллелить надо ожидание, а не отправку, — это то же правило, что и в
 * остальном коде Arsenkin: ожидание не попытка. Ожидание идёт под
 * `withArsenkinTaskSlot`, постановка — здесь, по одной.
 */
export async function withArsenkinSubmitSlot<T>(fn: () => Promise<T>): Promise<T> {
  return withGate(submits, 1, fn);
}

/** Занятые слоты отправки — для проверок. */
export function activeArsenkinSubmitSlots(): number {
  return submits.active;
}

/** Сброс между проверками: счётчики модульные, тесты не должны наследовать чужие. */
export function resetArsenkinTaskSlotsForTest(): void {
  tasks.active = 0;
  tasks.waiting.length = 0;
  submits.active = 0;
  submits.waiting.length = 0;
}
