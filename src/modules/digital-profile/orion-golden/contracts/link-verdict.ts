/**
 * Решение по одной ссылке из ТОП-20 и свод по всем решениям.
 *
 * Зачем это нужно. Сейчас тема материала выбирается из справочника рубрик по
 * заголовку и сниппету — то есть по двум строкам, которые поисковик показал в
 * выдаче. Этого достаточно, чтобы отличить санкционный список от биографии, и
 * недостаточно для всего остального: в живом отчёте телеинтервью 2015 года
 * оказалось в теме «Криминальные / судебные материалы», а биографическая
 * справка — в «Офшорах». Клиент открывает ссылку под словом «критический» и
 * перестаёт верить отчёту целиком.
 *
 * Форма решения. Свободный текст «человеческого вывода» по каждой ссылке дал
 * бы девяносто абзацев прозы, которые нельзя ни проверить, ни сложить в число.
 * Поэтому решение — структура: о субъекте или нет, тональность, тема одной
 * фразой, цитаты, на которых вывод держится. Вывод без цитаты не принимается:
 * это то же правило, по которому в отчёте живут находки.
 *
 * Свод. Темы получаются суммированием решений, и сумма по темам обязана
 * сходиться с числом нежелательных ссылок. В эталоне отрасли
 * (`docs/etalon-orion-razbor.md`) это видно на слайде тем: 24 + 21 + 7 + 4 + 2
 * равно 58 — ровно столько же, сколько нежелательных ссылок в метрике выше.
 * Числа, которые не сходятся между страницами, читаются как выдуманные.
 */

import { z } from "zod";

export const LINK_VERDICT_SCHEMA_VERSION = "link-verdict-v1" as const;

/** Тональность материала для проверяющего, а не для автора. */
export const LinkToneSchema = z.enum(["adverse", "neutral", "supportive"]);
export type LinkTone = z.infer<typeof LinkToneSchema>;

/** Принадлежность материала проверяемому лицу. */
export const LinkSubjectMatchSchema = z.enum(["subject", "likely", "other", "unclear"]);
export type LinkSubjectMatch = z.infer<typeof LinkSubjectMatchSchema>;

/** Почему страницу не удалось прочитать — это тоже результат, а не пустота. */
export const LinkReadFailureSchema = z.enum([
  "not_fetched",
  "blocked",
  "not_found",
  "empty_text",
  "timeout",
]);

export const LinkQuoteSchema = z.object({
  /** Дословная цитата из страницы — основание вывода. */
  text: z.string().min(10).max(400),
});

export const LinkVerdictSchema = z.object({
  schemaVersion: z.literal(LINK_VERDICT_SCHEMA_VERSION),
  /** Наблюдение, к которому относится решение. */
  evidenceRef: z.string().min(1),
  url: z.string().min(1),
  domain: z.string().optional(),
  /** Позиция в выдаче и запрос — чтобы решение можно было привязать к странице. */
  rank: z.number().int().positive().optional(),
  query: z.string().optional(),
  subjectMatch: LinkSubjectMatchSchema,
  tone: LinkToneSchema,
  /**
   * Тема одной фразой — то, о чём публикация, а не рубрика справочника.
   * «Совместный бизнес с чиновником», а не «Криминальные материалы».
   */
  theme: z.string().min(4).max(120),
  /** Цитаты, на которых держится вывод. Пустой список допустим только у нейтральных. */
  quotes: z.array(LinkQuoteSchema).max(3).default([]),
  /** Дата публикации, если она есть на странице. */
  publishedAt: z.string().optional(),
  /** Не удалось прочитать — вывод сделан по заголовку и сниппету. */
  readFailure: LinkReadFailureSchema.optional(),
  /** Когда страница была прочитана. */
  readAt: z.string(),
});

export type LinkVerdict = z.infer<typeof LinkVerdictSchema>;

export const LinkVerdictSetSchema = z.object({
  schemaVersion: z.literal(LINK_VERDICT_SCHEMA_VERSION),
  caseId: z.string().min(1),
  verdicts: z.array(LinkVerdictSchema),
});

export type LinkVerdictSet = z.infer<typeof LinkVerdictSetSchema>;

/** Тема свода: формулировка и сколько публикаций её подтверждают. */
export type VerdictThemeSummary = {
  theme: string;
  /** Сколько публикаций отнесено к теме. */
  count: number;
  /** Из них нежелательных. */
  adverseCount: number;
  /** Ссылки-примеры в порядке позиции в выдаче. */
  examples: Array<{ url: string; domain?: string; rank?: number }>;
};

export type VerdictSummary = {
  /** Сколько решений принято всего. */
  total: number;
  /** Сколько из них нежелательных — знаменатель темы. */
  adverse: number;
  /** Сколько страниц не удалось прочитать: честная часть покрытия. */
  unread: number;
  themes: VerdictThemeSummary[];
};

/**
 * Свести решения в темы.
 *
 * В свод идут только материалы о субъекте: публикация о другом человеке не
 * может подтверждать тему риска проверяемого лица, сколько бы раз она ни
 * встретилась в выдаче. Темы упорядочены по числу нежелательных публикаций —
 * так же читается таблица тем в эталоне.
 *
 * Сумма `adverseCount` по темам равна `adverse` — это свойство проверяется
 * тестом, потому что расхождение чисел между страницами отчёта клиент замечает
 * раньше любой ошибки в формулировке.
 */
export function summarizeLinkVerdicts(verdicts: LinkVerdict[]): VerdictSummary {
  const own = verdicts.filter((v) => v.subjectMatch === "subject");
  const byTheme = new Map<string, VerdictThemeSummary>();

  for (const v of own) {
    const key = v.theme.trim();
    if (!key) continue;
    const bucket = byTheme.get(key) ?? {
      theme: key,
      count: 0,
      adverseCount: 0,
      examples: [],
    };
    bucket.count += 1;
    if (v.tone === "adverse") bucket.adverseCount += 1;
    if (bucket.examples.length < 5) {
      bucket.examples.push({ url: v.url, domain: v.domain, rank: v.rank });
    }
    byTheme.set(key, bucket);
  }

  const themes = [...byTheme.values()]
    .map((t) => ({
      ...t,
      examples: [...t.examples].sort(
        (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
      ),
    }))
    .sort((a, b) => b.adverseCount - a.adverseCount || b.count - a.count || a.theme.localeCompare(b.theme, "ru"));

  return {
    total: verdicts.length,
    adverse: own.filter((v) => v.tone === "adverse").length,
    unread: verdicts.filter((v) => Boolean(v.readFailure)).length,
    themes,
  };
}

/**
 * Принять решение только с основанием.
 *
 * Нежелательный вывод без цитаты — это мнение модели, а не факт со страницы.
 * Такие решения понижаются до «неясно»: в отчёте они останутся видимыми
 * материалами, но не будут подтверждать тему риска.
 */
export function requireQuotedAdverse(verdict: LinkVerdict): LinkVerdict {
  if (verdict.tone !== "adverse") return verdict;
  if (verdict.quotes.length > 0) return verdict;
  return { ...verdict, tone: "neutral", subjectMatch: "unclear" };
}
