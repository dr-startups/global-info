/**
 * Агент проверки выводов: сверяет решение по ссылке с текстом самой страницы.
 *
 * Первый агент приносит текст, модель выносит по нему решение — и на этом
 * доверие заканчивается. Правило «нежелательный вывод только с цитатой» уже
 * есть, но оно проверяет наличие цитаты, а не её подлинность: строку, которой
 * на странице нет, система принимала наравне с настоящей. Для отчёта, где
 * цитата — единственное основание слова «критический», это дыра.
 *
 * Проверки здесь дословные и без модели: сверка идёт с текстом, который
 * прочитал первый агент. Ничего не переписываем в лучшую сторону — только
 * понижаем необоснованное:
 *
 * — **Цитаты нет на странице** → цитата снимается. Не «поправить формулировку»,
 *   а убрать основание, которого не было.
 * — **После снятия цитат нежелательный вывод остался без опоры** → он
 *   понижается до нейтрального с пометкой «неясно» (то же правило, что и
 *   раньше, но теперь по проверенным цитатам).
 * — **Фамилии субъекта нет в тексте, а решение говорит «это он»** → решение
 *   понижается до «неясно»: страница о ком-то другом или не о человеке вовсе.
 *
 * Каждое изменение записывается с причиной: правка, которую нельзя объяснить,
 * ничем не лучше ошибки, которую она исправляет.
 */

import { requireQuotedAdverse, type LinkVerdict } from "../contracts/link-verdict";

export type VerdictAuditChange = {
  evidenceRef: string;
  url: string;
  /** Что именно сделали с решением. */
  action: "quote_dropped" | "adverse_downgraded" | "subject_downgraded";
  reason: string;
};

export type VerdictAuditReport = {
  checked: number;
  /** Сколько решений опиралось на непроверяемые цитаты. */
  quotesDropped: number;
  adverseDowngraded: number;
  subjectDowngraded: number;
  changes: VerdictAuditChange[];
};

/** Текст страницы, по которому проверяется решение. */
export type VerdictAuditSource = {
  evidenceRef: string;
  text?: string;
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[«»"'`„“”]/gu, "")
    .replace(/[ \s]+/gu, " ")
    .replace(/[–—]/gu, "-")
    .trim();
}

/**
 * Есть ли цитата в тексте страницы.
 *
 * Сравнение по нормализованному тексту: кавычки, тире и переносы — вёрстка, а
 * не содержание. Разбитая на строки цитата остаётся той же цитатой, а
 * придуманная не совпадёт ни в каком виде.
 */
export function quoteFoundInText(quote: string, pageText: string): boolean {
  const needle = normalize(quote);
  if (needle.length < 10) return false;
  return normalize(pageText).includes(needle);
}

/** Упомянут ли субъект в тексте страницы — по фамилии и её латинскому виду. */
export function subjectMentioned(pageText: string, names: readonly string[]): boolean {
  const haystack = normalize(pageText);
  return names
    .map((n) => normalize(n))
    .filter((n) => n.length >= 3)
    .some((n) => haystack.includes(n));
}

/**
 * Проверить решения по прочитанным страницам.
 *
 * Страницы, которые прочитать не удалось, не проверяются: у них нет текста, с
 * которым можно сверять, и их решения уже помечены как «не знаем».
 */
export function auditLinkVerdicts(input: {
  verdicts: readonly LinkVerdict[];
  sources: readonly VerdictAuditSource[];
  /** Написания имени субъекта: фамилия, полное имя, транслит. */
  subjectNames: readonly string[];
}): { verdicts: LinkVerdict[]; report: VerdictAuditReport } {
  const textByRef = new Map(
    input.sources.filter((s) => s.text && s.text.trim()).map((s) => [s.evidenceRef, s.text!])
  );
  const changes: VerdictAuditChange[] = [];
  let quotesDropped = 0;
  let adverseDowngraded = 0;
  let subjectDowngraded = 0;
  let checked = 0;

  const verdicts = input.verdicts.map((verdict) => {
    const text = textByRef.get(verdict.evidenceRef);
    if (!text) return verdict;
    checked += 1;
    let next = verdict;

    const kept = verdict.quotes.filter((q) => quoteFoundInText(q.text, text));
    if (kept.length !== verdict.quotes.length) {
      const dropped = verdict.quotes.length - kept.length;
      quotesDropped += dropped;
      changes.push({
        evidenceRef: verdict.evidenceRef,
        url: verdict.url,
        action: "quote_dropped",
        reason: `цитат не найдено в тексте страницы: ${dropped}`,
      });
      next = { ...next, quotes: kept };
    }

    const afterQuotes = requireQuotedAdverse(next);
    if (afterQuotes.tone !== next.tone) {
      adverseDowngraded += 1;
      changes.push({
        evidenceRef: verdict.evidenceRef,
        url: verdict.url,
        action: "adverse_downgraded",
        reason: "нежелательный вывод остался без подтверждённой цитаты",
      });
    }
    next = afterQuotes;

    if (
      (next.subjectMatch === "subject" || next.subjectMatch === "likely") &&
      !subjectMentioned(text, input.subjectNames)
    ) {
      subjectDowngraded += 1;
      changes.push({
        evidenceRef: verdict.evidenceRef,
        url: verdict.url,
        action: "subject_downgraded",
        reason: "имени субъекта нет в тексте страницы",
      });
      next = { ...next, subjectMatch: "unclear", tone: next.tone === "adverse" ? "neutral" : next.tone };
    }

    return next;
  });

  return {
    verdicts,
    report: { checked, quotesDropped, adverseDowngraded, subjectDowngraded, changes },
  };
}

/** Строка о работе проверки для лога прогона. */
export function verdictAuditLogLine(report: VerdictAuditReport): string {
  if (report.checked === 0) return "[digital-profile][выводы] проверять нечего: прочитанных страниц нет";
  const parts = [`проверено решений: ${report.checked}`];
  if (report.quotesDropped > 0) parts.push(`снято непроверяемых цитат: ${report.quotesDropped}`);
  if (report.adverseDowngraded > 0) parts.push(`понижено нежелательных: ${report.adverseDowngraded}`);
  if (report.subjectDowngraded > 0) parts.push(`снято ошибочных «это он»: ${report.subjectDowngraded}`);
  return `[digital-profile][выводы] ${parts.join(", ")}`;
}
