/**
 * Разбор статьи Википедии по существу.
 *
 * Задача клиента звучит так: найти статью по ФИО, убедиться, что она о
 * субъекте, вынести основное описание на слайд и **отдельно** выделить
 * фрагменты с негативом или требующие исправления — с рекомендацией, что
 * именно с ними делать.
 *
 * Что здесь делает модель и что не делает. Модель **выбирает и называет**:
 * какие места текста создают вопросы и о чём каждое из них одной русской
 * фразой. Она не пишет за клиента новый текст статьи: это означало бы
 * утверждать биографические факты, которых нет ни в одном наблюдении, — прямое
 * нарушение правила «LLM не добавляет фактов». Рекомендация — детерминированный
 * шаблон по категории, то есть «что сделать с фрагментом», а не «что написать
 * вместо него».
 *
 * Дословность — инвариант. Цитата фрагмента обязана быть подстрокой
 * `articleText` из снимка проверки, и это проверяется детерминированным
 * аудитом, а не доверием к ответу модели. Не подтвердившаяся цитата снимается
 * с записью причины.
 *
 * Пустое состояние честнее выдуманного: разбор без модели (нет ключа, офлайн)
 * — это `NOT_REVIEWED` с причиной, а не «негатива не выявлено».
 */

import { z } from "zod";

export const WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION = "wikipedia-article-review-v1" as const;

/** Что не так с фрагментом: он негативен либо устарел и требует проверки. */
export const WikipediaFragmentCategorySchema = z.enum(["negative", "needs_update"]);

/** Принадлежность статьи проверяемому лицу по прочтению её текста. */
export const WikipediaReviewSubjectMatchSchema = z.enum([
  "subject",
  "likely",
  "other",
  "unclear",
]);

/** Почему разбор не выполнялся. Состояние, а не отсутствие данных. */
export const WikipediaReviewNotReviewedReasonSchema = z.enum(["offline", "model-unavailable"]);
export type WikipediaReviewNotReviewedReason = z.infer<
  typeof WikipediaReviewNotReviewedReasonSchema
>;

export const WikipediaArticleFragmentSchema = z.object({
  /** Дословная цитата из текста статьи, проверенная аудитом. */
  quote: z.string().min(20).max(220),
  category: WikipediaFragmentCategorySchema,
  /** О чём фрагмент — одной русской фразой; иноязычная цитата идёт дословно. */
  gloss: z.string().min(4).max(100),
  /** Раздел статьи, в котором стоит цитата; у цитаты из лида раздела нет. */
  section: z.string().max(160).optional(),
});
export type WikipediaArticleFragment = z.infer<typeof WikipediaArticleFragmentSchema>;

export const WikipediaArticleReviewSchema = z.object({
  /** Запись проверки, к которой относится разбор (`inventory:wiki-<id>`). */
  checkRef: z.string().min(1),
  language: z.string().min(1),
  title: z.string().min(1),
  url: z.string().optional(),
  /** Основное описание: текст статьи до первого заголовка раздела. */
  lead: z.string().default(""),
  /** Заголовки разделов статьи в порядке следования. */
  sections: z.array(z.string()).default([]),
  articleTextChars: z.number().int().nonnegative(),
  /** Сколько знаков реально ушло в разбор (кап входа модели). */
  reviewedChars: z.number().int().nonnegative(),
  truncated: z.boolean().default(false),
  subjectMatch: WikipediaReviewSubjectMatchSchema,
  fragments: z.array(WikipediaArticleFragmentSchema).max(8).default([]),
  /** Что аудит снял и почему. Правка без объяснения — та же ошибка. */
  audit: z.object({
    dropped: z.number().int().nonnegative(),
    reasons: z.array(z.string()).default([]),
  }),
  status: z.enum(["REVIEWED", "NOT_REVIEWED"]),
  notReviewedReason: WikipediaReviewNotReviewedReasonSchema.optional(),
});
export type WikipediaArticleReview = z.infer<typeof WikipediaArticleReviewSchema>;

export const WikipediaArticleReviewSetSchema = z.object({
  schemaVersion: z.literal(WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION),
  caseId: z.string().min(1),
  reviews: z.array(WikipediaArticleReviewSchema),
});
export type WikipediaArticleReviewSet = z.infer<typeof WikipediaArticleReviewSetSchema>;
