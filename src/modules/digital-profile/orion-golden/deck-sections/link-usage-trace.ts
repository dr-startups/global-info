/**
 * Что модель сказала о ссылке и что из этого дошло до отчёта.
 *
 * Между решением по прочитанной странице и напечатанной страницей отчёта лежит
 * десяток отборов: годна ли цитата, не обрезан ли заголовок, попал ли материал
 * в тему, не сняла ли его вычистка повторов. Каждый отбор осмыслен по
 * отдельности, а вместе они непрозрачны: по готовому отчёту нельзя сказать,
 * почему конкретной ссылки в нём нет — её не прочитали, её вывод понизили или
 * её цитату забраковали.
 *
 * След отвечает на этот вопрос одной строкой на ссылку. Он не для клиента: это
 * рабочий артефакт разбора прогона, и живёт он рядом с деком.
 */

import type { ScopedEvidenceIndex } from "./scoped-input";

/** Как ссылка представлена в отчёте. */
export type LinkUsage =
  /** Напечатана цитата с прочитанной страницы. */
  | "цитата со страницы"
  /** Напечатан заголовок из выдачи. */
  | "заголовок из выдачи"
  /** Материал в отчёте есть, но без цитаты — строкой таблицы или счётчиком. */
  | "без цитаты"
  /**
   * Своих слов в отчёте нет, но страница стоит на этом наблюдении.
   *
   * Так выглядит материал, свёрнутый в сюжет: страница печатает число
   * публикаций и перечень доменов, а самой цитаты и заголовка на ней нет.
   * Это **не потеря** — на живом прогоне 20.08 трасса объявила «не дошла» 42
   * ссылки из 80, и по деке проверено, что в отчёте есть все 42.
   */
  | "в составе страницы"
  /** Материала в отчёте нет вовсе. */
  | "не дошла";

export type LinkUsageRow = {
  evidenceRef: string;
  url?: string;
  domain?: string;
  rank?: number;
  region?: string;
  /** Решение модели по прочитанной странице. */
  tone?: string;
  theme?: string;
  /** Цитата со страницы, прошедшая проверку годности. */
  pageQuote?: string;
  /** Заголовок из выдачи — то, что предлагал поисковик. */
  serpTitle?: string;
  usage: LinkUsage;
  /** Где именно материал виден в отчёте. */
  slides: string[];
};

export type LinkUsageTrace = {
  version: "link-usage-trace-v1";
  summary: {
    total: number;
    quotedFromPage: number;
    quotedFromTitle: number;
    withoutQuote: number;
    /** Учтён страницей, но своих слов в отчёте не имеет. Это не потеря. */
    countedOnly: number;
    missing: number;
  };
  rows: LinkUsageRow[];
};

type TracedSlide = {
  slideKey?: string;
  title?: string;
  narrative?: string;
  bullets?: string[];
  table?: { rows?: string[][]; rowAddresses?: string[] } | null;
  /**
   * Основания страницы. Признак точный: список не зависит от того, как сложился
   * её текст, — в отличие от поиска по словам, который материал, вошедший
   * числом и доменом, не находит вовсе.
   */
  evidenceRefs?: readonly string[];
};

function slideText(slide: TracedSlide): string {
  const table = [
    ...(slide.table?.rows ?? []).map((r) => r.join(" ")),
    // Адрес материала печатается полосой под своей строкой — это по-прежнему
    // слова страницы, и след ссылок обязан их видеть.
    ...(slide.table?.rowAddresses ?? []),
  ].join(" ");
  return [slide.title, slide.narrative, ...(slide.bullets ?? []), table]
    .filter(Boolean)
    .join("\n");
}

/** Сравнимый вид: регистр и пробелы у одной и той же фразы отличаются, смысл нет. */
function key(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * Собрать след по индексу доказательств и готовым слайдам.
 *
 * Функция чистая: ни файлов, ни сети. В след попадают только ссылки, по которым
 * есть решение модели, — об остальных сказать нечего, и строка о них была бы
 * шумом.
 */
export function buildLinkUsageTrace(input: {
  evidenceIndex: ScopedEvidenceIndex;
  slides: readonly TracedSlide[];
}): LinkUsageTrace {
  const texts = input.slides.map((s) => ({
    slideKey: s.slideKey ?? "",
    text: key(slideText(s)),
    refs: new Set(s.evidenceRefs ?? []),
  }));

  const rows: LinkUsageRow[] = [];
  for (const [ref, e] of Object.entries(input.evidenceIndex)) {
    const judged = Boolean(e.readVerdictTone || e.verdictTheme || e.pageQuote);
    if (!judged) continue;

    const pageQuote = e.pageQuote?.trim();
    const serpTitle = e.title?.trim();
    // Цитата длинная, и совпадение по её началу надёжнее полного равенства:
    // в отчёте она может быть укорочена по бюджету страницы.
    const quoteNeedle = pageQuote ? key(pageQuote).slice(0, 60) : "";
    const titleNeedle = serpTitle ? key(serpTitle).slice(0, 40) : "";
    const urlNeedle = e.url ? key(e.url).replace(/^https?:\/\/(www\.)?/u, "").slice(0, 40) : "";

    const slides: string[] = [];
    const countedOn: string[] = [];
    let quotedPage = false;
    let quotedTitle = false;
    for (const s of texts) {
      const hasQuote = quoteNeedle.length >= 20 && s.text.includes(quoteNeedle);
      const hasTitle = titleNeedle.length >= 12 && s.text.includes(titleNeedle);
      const hasUrl = urlNeedle.length >= 12 && s.text.includes(urlNeedle);
      if (!hasQuote && !hasTitle && !hasUrl) {
        // Своих слов на странице нет — но страница может стоять на этом
        // наблюдении, и тогда материал учтён, а не потерян.
        if (s.refs.has(ref)) countedOn.push(s.slideKey);
        continue;
      }
      slides.push(s.slideKey);
      quotedPage = quotedPage || hasQuote;
      quotedTitle = quotedTitle || hasTitle;
    }

    const usage: LinkUsage = quotedPage
      ? "цитата со страницы"
      : quotedTitle
        ? "заголовок из выдачи"
        : slides.length > 0
          ? "без цитаты"
          : countedOn.length > 0
            ? "в составе страницы"
            : "не дошла";

    rows.push({
      evidenceRef: ref,
      ...(e.url ? { url: e.url } : {}),
      ...(e.domain ? { domain: e.domain } : {}),
      ...(typeof e.rank === "number" ? { rank: e.rank } : {}),
      ...(e.region ? { region: e.region } : {}),
      ...(e.readVerdictTone ? { tone: e.readVerdictTone } : {}),
      ...(e.verdictTheme ? { theme: e.verdictTheme } : {}),
      ...(pageQuote ? { pageQuote } : {}),
      ...(serpTitle ? { serpTitle } : {}),
      usage,
      slides: slides.length > 0 ? slides : countedOn,
    });
  }

  rows.sort((a, b) => a.evidenceRef.localeCompare(b.evidenceRef));
  const count = (u: LinkUsage): number => rows.filter((r) => r.usage === u).length;
  return {
    version: "link-usage-trace-v1",
    summary: {
      total: rows.length,
      quotedFromPage: count("цитата со страницы"),
      quotedFromTitle: count("заголовок из выдачи"),
      withoutQuote: count("без цитаты"),
      countedOnly: count("в составе страницы"),
      missing: count("не дошла"),
    },
    rows,
  };
}

/** Строка о следе для лога прогона — коротко и по делу. */
export function linkUsageLogLine(trace: LinkUsageTrace): string {
  const s = trace.summary;
  return (
    `[digital-profile][ссылки→отчёт] разобрано ${s.total}: ` +
    `цитата со страницы — ${s.quotedFromPage}, заголовок — ${s.quotedFromTitle}, ` +
    `без цитаты — ${s.withoutQuote}, в составе страницы — ${s.countedOnly}, ` +
    `не дошло — ${s.missing}`
  );
}
