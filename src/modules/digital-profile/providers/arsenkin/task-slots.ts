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

let active = 0;
const waiting: Array<() => void> = [];

function capacity(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, arsenkinAccountLimiterConfig(env).maxConcurrent);
}

/** Занятые слоты — для проверок и диагностики. */
export function activeArsenkinTaskSlots(): number {
  return active;
}

/** Ожидающие слота — для проверок и диагностики. */
export function waitingArsenkinTaskSlots(): number {
  return waiting.length;
}

async function acquire(): Promise<void> {
  if (active < capacity()) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => {
    waiting.push(resolve);
  });
  active += 1;
}

function release(): void {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

/**
 * Выполняет `fn`, заняв один слот задачи. Очередь — в порядке поступления.
 */
export async function withArsenkinTaskSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Сброс между проверками: счётчик модульный, тесты не должны наследовать чужой. */
export function resetArsenkinTaskSlotsForTest(): void {
  active = 0;
  waiting.length = 0;
}
