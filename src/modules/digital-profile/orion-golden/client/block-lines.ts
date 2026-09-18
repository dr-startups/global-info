/**
 * Как блок клиентского текста становится строкой провода — один ответ.
 *
 * Блок — это заголовок и части: счётная фраза, источники, цитата, оговорка,
 * пункт перечня. Построитель их знает, и до шага 0097 сам же и терял: склеивал
 * части пробелом, а заголовок приклеивал точкой («Тема. Найдены…»). Рендерер
 * получал стену текста и угадывал структуру регулярками, которые знали
 * позапрошлую форму текста.
 *
 * Структура блока — его строки. Перенос строки объявлен в проекте решением
 * вёрстки, а не текста (`client-text-snapshot.ts`, `norm`): бюджеты знаков,
 * вычистка повторов, ворот следа и эталон слов его не видят, поэтому разметкой
 * служит он, а не знаки внутри текста. Рендерер определяет роль строки по её
 * форме (`renderer/orion_golden_render/typography.py`):
 *
 * - **заголовок блока — первая строка без конечного знака.** Поэтому точка у
 *   заголовка снимается здесь: с точкой он был бы первым предложением тела;
 * - остальные строки — законченные предложения, какими их и пишут построители
 *   (`finishSentence`).
 */

/** Заголовок блока: без конечной точки. Вопрос и многоточие — слова автора, они остаются. */
export function blockHeading(text: string | undefined): string {
  return String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\.$/u, "");
}

/** Блок строками: заголовок (если есть) и непустые части, каждая своей строкой. */
export function composeBlockLines(heading: string | undefined, lines: readonly string[]): string {
  const head = blockHeading(heading);
  const body = lines.map((l) => String(l ?? "").replace(/\s+/gu, " ").trim()).filter(Boolean);
  return [head, ...body].filter(Boolean).join("\n");
}

/**
 * Записи блока с оговорками: факт — строкой, оговорка — следующей строкой.
 *
 * Роль строки в рендерере — свойство строки целиком (шаг 0105): оговорка,
 * приклеенная к факту пробелом, печаталась бы чёрным вместе с ним. Одинаковая
 * оговорка у всех записей блока печатается один раз, последней строкой: три
 * раза подряд «сигнал требует сверки» — не три оговорки, а одна, повторённая.
 */
export function linesWithCaveats(items: readonly { line: string; caveat: string }[]): string[] {
  const clean = items.map((it) => ({ line: it.line.trim(), caveat: it.caveat.trim() }));
  const distinct = new Set(clean.map((it) => it.caveat).filter(Boolean));
  if (distinct.size <= 1) {
    const [shared] = distinct;
    return [...clean.map((it) => it.line).filter(Boolean), ...(shared ? [shared] : [])];
  }
  return clean.flatMap((it) => [it.line, it.caveat].filter(Boolean));
}
