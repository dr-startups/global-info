/**
 * Цели Яндекс Метрики — один `track()` на весь сайт.
 *
 * Счётчика может не быть (стенд, пустая настройка), а его скрипт может
 * заблокировать расширение браузера. Аналитика при этом молчит: путь посетителя
 * не ломается ни отказом, ни исключением.
 */

/** Цели из ТЗ 3.11. */
export const SITE_GOALS = [
  "form_start",
  "form_submit",
  "persona_shown",
  "persona_decided",
  "run_started",
  "verdict_shown",
  "lead_sent",
] as const;

export type SiteGoal = (typeof SITE_GOALS)[number];

export const METRIKA_SCRIPT_SRC = "https://mc.yandex.ru/metrika/tag.js";

type Ym = (...args: unknown[]) => void;

let counterId: number | null = null;

/** Номер счётчика из `GET /api/site/config`; пусто или не число — целей нет. */
export function setMetrikaCounter(id: string | null): void {
  const n = Number(id);
  counterId = id && Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function track(goal: SiteGoal, params?: Record<string, unknown>): void {
  if (counterId === null) return;
  const ym = (globalThis as { ym?: Ym }).ym;
  if (typeof ym !== "function") return;
  try {
    if (params) ym(counterId, "reachGoal", goal, params);
    else ym(counterId, "reachGoal", goal);
  } catch {
    // Упавший скрипт счётчика — не повод прерывать проверку.
  }
}

/** Настройки счётчика. Вебвизор выключен: на страницах формы с ФИО и датой рождения. */
export function metrikaInitOptions() {
  return { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: false };
}

let initialized = false;

/**
 * Подключить счётчик — только когда номер задан. Очередь `ym.a` — штатный
 * приём Метрики: вызовы до загрузки скрипта не теряются.
 */
export function loadMetrika(id: string): void {
  setMetrikaCounter(id);
  if (counterId === null || initialized || typeof document === "undefined") return;
  initialized = true;
  const host = globalThis as { ym?: Ym & { a?: IArguments[]; l?: number } };
  if (typeof host.ym !== "function") {
    const queue = function () {
      // eslint-style `arguments` намеренно: скрипт Метрики разбирает очередь именно так.
      // eslint-disable-next-line prefer-rest-params
      (queue.a = queue.a || []).push(arguments);
    } as unknown as Ym & { a?: IArguments[]; l?: number };
    queue.l = Date.now();
    host.ym = queue;
    const script = document.createElement("script");
    script.async = true;
    script.src = METRIKA_SCRIPT_SRC;
    document.head.appendChild(script);
  }
  host.ym?.(counterId, "init", metrikaInitOptions());
}

/** Просмотр страницы при переходе без перезагрузки. */
export function metrikaHit(url: string): void {
  if (counterId === null || !initialized) return;
  const ym = (globalThis as { ym?: Ym }).ym;
  if (typeof ym !== "function") return;
  try {
    ym(counterId, "hit", url);
  } catch {
    // см. track()
  }
}
