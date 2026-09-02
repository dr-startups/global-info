/**
 * Сверка каталога нарисованных страниц с декой — один ответ на два прибора.
 *
 * Ворот `pageParity` приёмки эталона и подтест офлайн-смока спрашивали одно и
 * то же и оба отвечали счётом файлов. Счёт слабее вопроса: каталог `pages-png`
 * дописывается (страницы пишет `render-orion-golden-artifacts.py`, сносит
 * каталог только сам скрипт ворот, а восстановление эталона копией лишнего не
 * убирает), поэтому пропавшая страница вместе с лишней давали прежнее число и
 * зелёный прибор. Замер 30.08: `page-13.png`, переименованный в `page-99.png`,
 * проходил оба прибора.
 *
 * Здесь спрашивается сильнее: набор номеров равен `{1 … pageCount}`. Из имени
 * берётся только число — формат имени знает тот, кто его пишет, и третьего
 * знания об этом заводить не надо.
 */

/** Номер страницы из имени файла; `null` — имя не про страницу. */
function pageNumberOf(fileName: string): number | null {
  const match = /^page-(\d+)\.png$/iu.exec(fileName);
  return match ? Number(match[1]) : null;
}

/** Не больше десяти номеров в строке отказа: дальше он перестаёт читаться. */
function listed(numbers: number[]): string {
  const head = numbers.slice(0, 10).join(", ");
  return numbers.length > 10 ? `${head} и ещё ${numbers.length - 10}` : head;
}

/**
 * Претензия к каталогу страниц либо `null`, если он в точности равен деке.
 *
 * `pageCount = 0` — тоже претензия: «ноль страниц сошлись с нулём» неотличимо
 * от прогона, в котором не рисовали вовсе.
 */
export function pagesDirectoryMismatch(
  fileNames: readonly string[],
  pageCount: number
): string | null {
  if (pageCount <= 0) {
    return `дека объявила ${pageCount} страниц — сверять каталог не с чем`;
  }
  const drawn = new Set<number>();
  const foreign: string[] = [];
  for (const name of fileNames) {
    if (!name.toLowerCase().endsWith(".png")) continue;
    const number = pageNumberOf(name);
    if (number === null) foreign.push(name);
    else drawn.add(number);
  }
  const missing: number[] = [];
  for (let page = 1; page <= pageCount; page += 1) {
    if (!drawn.has(page)) missing.push(page);
  }
  const extra = [...drawn].filter((n) => n < 1 || n > pageCount).sort((a, b) => a - b);
  if (missing.length === 0 && extra.length === 0 && foreign.length === 0) return null;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`не нарисованы: ${listed(missing)}`);
  if (extra.length > 0) parts.push(`лишние: ${listed(extra)}`);
  if (foreign.length > 0) parts.push(`не страницы: ${foreign.slice(0, 10).join(", ")}`);
  return `каталог страниц разошёлся с декой (объявлено ${pageCount}); ${parts.join("; ")}`;
}
