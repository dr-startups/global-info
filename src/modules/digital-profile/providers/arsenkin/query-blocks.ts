/**
 * Контейнер «по запросу» в ответе Arsenkin — один разбор на всех.
 *
 * Инструменты `paa` и `suggest` отдают результат по запросам: списком списков
 * (`result: [[…], […]]`, по блоку на запрос) или словарём списков
 * (`result: {"0": […], "1": […]}`). Пустой ответ — те же контейнеры без
 * содержимого: на прогоне DPA-2026-0054 «люди также спрашивают» пришло как
 * `total: 0, result: [[]]`, и это честный ответ «вопросов нет», а не ошибка.
 *
 * Поэтому разбор отвечает на два вопроса раздельно: `present` — контейнер есть
 * (провайдер ответил), `items` — что в нём. Пустой контейнер это `present: true`
 * и ноль элементов; форма без контейнера — `present: false`, и вызывающий не
 * выдумывает пустоту там, где ответа не было.
 *
 * Пока контейнер разбирали в трёх местах (конверт для PAA, конверт для подсказок,
 * провайдерный адаптер подсказок), ответы расходились: шаг 0053 научил список
 * списков только провайдерный адаптер, а единый прогон из 338 подсказок ОАЭ
 * оставлял одну строку.
 */

export type QueryBlocks = {
  /** Контейнер по запросу в ответе есть. */
  present: boolean;
  /** Элементы всех блоков подряд, без вложенности. */
  items: unknown[];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function queryBlocksOf(value: unknown): QueryBlocks {
  if (Array.isArray(value)) {
    return {
      present: true,
      items: value.flatMap((block) => (Array.isArray(block) ? (block as unknown[]).flat(3) : [block])),
    };
  }
  if (isPlainObject(value)) {
    const lists = Object.values(value).filter((v): v is unknown[] => Array.isArray(v));
    if (lists.length === 0) return { present: false, items: [] };
    return { present: true, items: lists.flatMap((list) => list.flat(3)) };
  }
  return { present: false, items: [] };
}
