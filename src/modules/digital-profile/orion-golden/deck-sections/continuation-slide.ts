/**
 * Страница-продолжение: один конструктор и один формат подписи.
 *
 * Подпись «(продолжение i/N)» печатали в четырёх местах и разбирали в пятом.
 * Пока число страниц цепочки задавалось построителем раз и навсегда, четыре
 * копии формата были безвредны. Перекладка по мере рендерера меняет число
 * страниц на каждой итерации — и печать, и разбор обязаны быть одни.
 */

import type { SlideBody, SlideContentContract } from "./contracts";

/** Подпись продолжения, которую можно перенумеровать. */
export const CONTINUATION_SUFFIX_RE = /\s*\(продолжение\s+(\d+)\/(\d+)\)\s*$/u;

/** Подпись страницы-продолжения: `i` — её номер в цепочке, `total` — длина цепочки. */
export function continuationTitle(baseTitle: string, index: number, total: number): string {
  return `${baseTitle} (продолжение ${index}/${total})`;
}

/** Номер продолжения из подписи, если она так устроена. */
export function continuationNumberInTitle(title: string): number | undefined {
  const m = CONTINUATION_SUFFIX_RE.exec(title);
  return m ? Number(m[1]) : undefined;
}

/**
 * Подпись без суффикса продолжения.
 *
 * Заголовок вида «Россия — Google, ТОП-20 (2/2)» остаётся как есть: это его
 * собственное имя, а не нумерация цепочки.
 */
export function stripContinuationSuffix(title: string): string {
  return title.replace(CONTINUATION_SUFFIX_RE, "");
}

/**
 * Построить страницу-продолжение блока.
 *
 * Заголовочные поля блока (KPI, рекомендация, доля прочитанного, вывод) —
 * свойство его **первой** страницы: повторяясь на каждом продолжении, они
 * занимали треть листа и не сообщали ничего нового («312 / 5 / 6 / 31» пять
 * страниц подряд). Поэтому конструктор их снимает, а не полагается на то, что
 * каждый вызыватель вспомнит это сделать.
 */
export function buildContinuationSlide(input: {
  base: SlideContentContract;
  /** Номер продолжения в цепочке, считая основу первой страницей: 2, 3, … */
  index: number;
  /** Сколько всего страниц в цепочке, включая основу. */
  totalPages: number;
  /** Подпись цепочки без суффикса; по умолчанию — подпись основы. */
  baseTitle?: string;
  content: SlideBody;
}): SlideContentContract {
  const contIndex = input.index - 1;
  return {
    ...input.base,
    slideId: `${input.base.slideId}__cont${contIndex}`,
    isContinuation: true,
    continuationOf: input.base.slideId,
    continuationIndex: contIndex,
    title: continuationTitle(
      input.baseTitle ?? stripContinuationSuffix(input.base.title),
      input.index,
      input.totalPages
    ),
    content: {
      ...input.content,
      whatWasFound: undefined,
      whyItMatters: undefined,
      kpis: undefined,
      whatToCheck: undefined,
      statusNote: undefined,
    },
  };
}
