/**
 * Агент чтения страниц: приносит текст и отвечает за статус этого шага.
 *
 * До него чтение было безымянным подшагом внутри аналитики: страницы читались
 * по одной, отказ ничем не отличался от отказа модели, повторов не было, а
 * прогон, в котором не прочиталась ни одна страница, считался успешным. Так и
 * вышло: из-за кириллицы в заголовке запроса три прогона подряд отчёт
 * сообщал, что все сто двадцать ссылок «не открываются».
 *
 * Поэтому у шага теперь есть свой отчёт: сколько запрошено, сколько
 * прочитано, по каким причинам отказано и сколько раз пришлось повторить.
 * Отказ сайта («robots не пускают») и поломка у нас («запрос не ушёл») —
 * разные вещи, и в статусе они разведены.
 *
 * Правила похода на чужие сайты:
 *
 * — **Повторяем только срывы связи.** «Страница не найдена» и «доступ закрыт»
 *   — это ответ сайта, а не помеха: повторять его значит стучаться в закрытую
 *   дверь второй раз.
 * — **Не больше нескольких страниц одновременно.** Читаем чужие сайты, а не
 *   свои: очередь ограничена, между попытками пауза.
 */

import { pluralRu } from "../../report/i18n/plural-ru";
import {
  readLinkPage,
  type LinkPageRead,
  type LinkReadFailure,
} from "../../services/link-page-reader";

/** Сколько страниц читаем одновременно. Чужие сайты, а не свои. */
export const LINK_READ_CONCURRENCY = 6;

/** Пауза перед повтором срыва связи. */
export const LINK_READ_RETRY_PAUSE_MS = 700;

/** Причины, которые повторять бессмысленно: это ответ сайта, а не помеха. */
const FINAL_FAILURES: ReadonlySet<LinkReadFailure> = new Set<LinkReadFailure>([
  "not_found",
  "blocked",
  "empty_text",
]);

export type LinkReadOutcome = {
  url: string;
  page: LinkPageRead;
  /** Сколько раз запрашивали страницу: 1 — с первого раза. */
  attempts: number;
};

export type LinkReadingStatus = "OK" | "PARTIAL" | "BROKEN" | "NO_LINKS";

export type LinkReadingReport = {
  status: LinkReadingStatus;
  requested: number;
  read: number;
  failed: number;
  retried: number;
  /** Сколько отказов какой причины — по ним видно, где чинить. */
  byReason: Record<string, number>;
  /** Первая техническая причина отказа — для разбора прогона. */
  firstFailureDetail?: string;
};

/**
 * Интро страницы тем: что прочитано, чем это ограничено и сколько из этого
 * нежелательного.
 *
 * Не больше двух предложений, и это не стилистика: `orion_golden_search_table`
 * печатает над таблицей ровно два полных предложения, а всё остальное
 * отбрасывает без записи. Оговорка о неполноте — часть утверждения, а не
 * украшение: если она не помещается, сокращать надо утверждение. Поэтому
 * строку покрытия и слова о темах собирает один помощник, а не два — и здесь,
 * рядом с местом, где эти числа родились.
 *
 * Числа покрытия — глобальные, по всему отчёту, а «нежелательных публикаций» —
 * региональное. Пометка «по отчёту» стоит именно для этого: без неё читатель
 * региональной страницы делит региональное число на глобальное.
 *
 * Абсолют «публикации прочитаны» разрешён только при полном чтении и только
 * вместе с числами: на прогоне 76 он был напечатан при 74 прочитанных из 120.
 */
export function linkReadingThemesIntro(input: {
  report?: LinkReadingReport;
  /** Сумма нежелательных публикаций по темам региона. */
  adverseTotal: number;
  /** Глубина выдачи, которую называет страница. */
  topN: number;
  /** Непрочитанное по своду прогона — единственный источник для легаси-входа. */
  unread: number;
}): string {
  const { report, adverseTotal, topN } = input;
  if (!report || report.requested === 0) {
    // Легаси-артефакт: темы есть, отчёта о чтении нет. Абсолюта тогда нет
    // вовсе — подтвердить его нечем.
    const unreadNote =
      input.unread > 0
        ? ` ${input.unread} ${pluralRu(input.unread, "страница", "страницы", "страниц")} не открылись — они в подсчёт тем не вошли.`
        : "";
    return `Каждая прочитанная публикация отнесена к теме по её содержанию, нежелательных публикаций: ${adverseTotal}.${unreadNote}`;
  }
  if (report.failed === 0 && report.read === report.requested) {
    return (
      `Публикации из ТОП-${topN} прочитаны (${report.read} из ${report.requested}), ` +
      `каждая отнесена к теме по её содержанию. Нежелательных публикаций: ${adverseTotal}.`
    );
  }
  const reasons = unreadReasons(report);
  const tail = reasons ? ` Из непрочитанных: ${reasons}.` : "";
  return (
    `Из ${report.requested} отобранных по отчёту страниц прочитано ${report.read}; ` +
    `каждая прочитанная отнесена к теме по её содержанию, нежелательных публикаций: ${adverseTotal}.${tail}`
  );
}

/**
 * Причины отказов словами. «N не открылись» скрывает разницу между отказом
 * сайта и поломкой у нас, а отчёт обязан говорить, чего он не прочитал.
 */
function unreadReasons(report: LinkReadingReport): string {
  const blocked = report.byReason.blocked ?? 0;
  const notFound = report.byReason.not_found ?? 0;
  const empty = report.byReason.empty_text ?? 0;
  const other = report.failed - blocked - notFound - empty;
  const parts: string[] = [];
  if (blocked > 0) parts.push(`${blocked} закрыли доступ`);
  if (notFound > 0) parts.push(`${notFound} не существует`);
  if (empty > 0) parts.push(`${empty} без читаемого текста`);
  if (other > 0) parts.push(`${other} не ответили`);
  return parts.join(", ");
}

/** Сводка по итогам чтения — она же статус шага. */
export function summarizeReads(outcomes: readonly LinkReadOutcome[]): LinkReadingReport {
  const read = outcomes.filter((o) => o.page.ok).length;
  const failed = outcomes.length - read;
  const byReason: Record<string, number> = {};
  let firstFailureDetail: string | undefined;
  for (const o of outcomes) {
    if (o.page.ok) continue;
    byReason[o.page.failure] = (byReason[o.page.failure] ?? 0) + 1;
    if (!firstFailureDetail && o.page.message) firstFailureDetail = o.page.message.slice(0, 200);
  }
  const status: LinkReadingStatus =
    outcomes.length === 0 ? "NO_LINKS" : read === 0 ? "BROKEN" : failed > 0 ? "PARTIAL" : "OK";
  return {
    status,
    requested: outcomes.length,
    read,
    failed,
    retried: outcomes.filter((o) => o.attempts > 1).length,
    byReason,
    firstFailureDetail,
  };
}

/**
 * Прочитать страницы. Возвращает результат по каждой ссылке в исходном
 * порядке — решение по ссылке должно ложиться рядом со строкой таблицы.
 */
export async function readLinks(
  urls: readonly string[],
  deps: {
    read?: (url: string) => Promise<LinkPageRead>;
    concurrency?: number;
    /** Пауза перед повтором; в тестах — ноль. */
    pause?: (ms: number) => Promise<void>;
    retries?: number;
  } = {}
): Promise<{ outcomes: LinkReadOutcome[]; report: LinkReadingReport }> {
  const read = deps.read ?? ((url: string) => readLinkPage(url));
  const concurrency = Math.max(1, Math.min(deps.concurrency ?? LINK_READ_CONCURRENCY, 12));
  const retries = Math.max(0, deps.retries ?? 1);
  const pause = deps.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const outcomes: LinkReadOutcome[] = new Array(urls.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= urls.length) return;
      const url = urls[i]!;
      let attempts = 0;
      let page = await read(url);
      attempts += 1;
      while (!page.ok && !FINAL_FAILURES.has(page.failure) && attempts <= retries) {
        await pause(LINK_READ_RETRY_PAUSE_MS);
        page = await read(url);
        attempts += 1;
      }
      outcomes[i] = { url, page, attempts };
    }
  });
  await Promise.all(workers);
  return { outcomes, report: summarizeReads(outcomes) };
}
