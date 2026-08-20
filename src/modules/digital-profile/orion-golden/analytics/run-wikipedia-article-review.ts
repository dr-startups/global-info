/**
 * Шаг прогона: разобрать текст найденной статьи Википедии по существу.
 *
 * Три части, и они намеренно неравноправны.
 *
 * **Детерминированная** — лид, список разделов, привязка фрагмента к разделу.
 * Работает всегда: без сети, без ключа, на одном снимке проверки. Именно она
 * даёт странице «основное описание дословно», и отсутствие модели её не
 * отменяет.
 *
 * **Модельная** — выбор мест текста, создающих вопросы, их категория и русская
 * подпись. Разрешение — существующий ключ OpenAI, нового флага нет. Без ключа
 * или офлайн шаг честно ставит `NOT_REVIEWED` с причиной: «негатива не
 * выявлено» и «мы не смотрели» — разные утверждения.
 *
 * **Аудит** — детерминированный и без модели. Каждая цитата обязана быть
 * подстрокой текста статьи (`quoteFoundInText` — тот же инструмент, что держит
 * цитаты прочитанных страниц); принадлежность держит пол `subjectMentioned`.
 * Повышения принадлежности мнением модели нет: полный тёзка проходит модельную
 * проверку насквозь, и подтверждённость печати обязана опираться на
 * детерминированный признак.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION,
  WikipediaArticleReviewSetSchema,
  WikipediaFragmentCategorySchema,
  type WikipediaArticleFragment,
  type WikipediaArticleReview,
  type WikipediaArticleReviewSet,
  type WikipediaReviewNotReviewedReason,
} from "../contracts/wikipedia-article-review";
import { callOpenAiStrictJson } from "../gpt/openai-json-client";
import {
  quoteFoundInText,
  subjectMentioned,
  subjectNameVariants,
} from "./link-verdict-audit-agent";
import { wikipediaCheckInventoryId } from "../../services/evidence-supplement-adapter";

/**
 * Кап входа модели. Без него одна статья в двести тысяч знаков молча съедала бы
 * бюджет вызова; с ним страница честно оговаривает, сколько знаков разобрано.
 */
export const WIKIPEDIA_ARTICLE_REVIEW_MAX_INPUT_CHARS = 60_000;
export const WIKIPEDIA_ARTICLE_REVIEW_MAX_FRAGMENTS = 8;
export const WIKIPEDIA_ARTICLE_REVIEW_QUOTE_MIN_CHARS = 20;
export const WIKIPEDIA_ARTICLE_REVIEW_QUOTE_MAX_CHARS = 220;
export const WIKIPEDIA_ARTICLE_REVIEW_GLOSS_MAX_CHARS = 100;

const SYSTEM_PROMPT = `Ты аналитик проверки деловой репутации. Тебе дают текст статьи Википедии и данные проверяемого лица.

Верни СТРОГО JSON:
{
  "subjectMatch": "subject" | "likely" | "other" | "unclear",
  "fragments": [
    {
      "quote": "<ДОСЛОВНЫЙ фрагмент текста статьи, 20-220 знаков>",
      "category": "negative" | "needs_update",
      "gloss": "<о чём этот фрагмент, одной фразой на русском, 4-100 знаков>"
    }
  ]
}

Правила:
1. subjectMatch — про то, о ТОМ ЛИ человеке статья. "other" — если это однофамилец, тёзка, род, населённый пункт или другой объект. "unclear" — если по тексту не определить.
2. quote — только ДОСЛОВНЫЙ фрагмент из переданного текста, символ в символ. Не перефразируй, не сокращай, не соединяй куски из разных мест. Придуманная цитата будет отброшена проверкой.
3. category: "negative" — фрагмент создаёт вопросы у банка или контрагента (суды, санкции, расследования, конфликты, обвинения). "needs_update" — сведения устарели или явно требуют проверки и актуализации.
4. gloss — назови СОДЕРЖАНИЕ фрагмента по-русски. Плохо: "негатив". Хорошо: "санкции ЕС 2022 года".
5. Не более ${WIKIPEDIA_ARTICLE_REVIEW_MAX_FRAGMENTS} фрагментов. Нейтральный текст — пустой список: отсутствие проблем тоже результат.
6. Ничего не предлагай и ничего не переписывай: рекомендации формируются без тебя.`;

/** Запись проверки, как её отдаёт `evidence-supplement.json`. */
export type WikipediaArticleReviewCheck = {
  id: string;
  exists?: boolean;
  language?: string | null;
  pageTitle?: string | null;
  url?: string | null;
  articleText?: string | null;
};

export type ArticleSection = { title: string; body: string };

/** Заголовок раздела плейнтекста извлечений: `== Санкции ==`, `=== … ===`. */
const HEADING_RE = /^(={2,6})\s*(.+?)\s*\1$/u;

/**
 * Лид и разделы статьи.
 *
 * Лид — текст до первого заголовка: это и есть «основное описание», ради
 * которого извлечения берутся вместо REST-сводки (она срезает скобки первого
 * предложения). Разделы нужны не для красоты: по ним фрагмент получает адрес в
 * статье, и клиент знает, куда смотреть.
 */
export function splitArticleText(articleText: string): {
  lead: string;
  sections: ArticleSection[];
} {
  const lines = String(articleText ?? "").split(/\r?\n/u);
  const leadLines: string[] = [];
  const sections: ArticleSection[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of lines) {
    const heading = HEADING_RE.exec(line.trim());
    if (heading) {
      if (current) sections.push({ title: current.title, body: current.lines.join("\n").trim() });
      current = { title: heading[2]!.trim(), lines: [] };
      continue;
    }
    (current ? current.lines : leadLines).push(line);
  }
  if (current) sections.push({ title: current.title, body: current.lines.join("\n").trim() });
  return { lead: leadLines.join("\n").trim(), sections };
}

/** Границы предложения, по которым цитату можно укоротить, не обрывая мысль. */
const SENTENCE_END_RE = /[.!?]\s/gu;

/**
 * Укоротить цитату до последней границы предложения в пределах капа.
 *
 * Многоточий не ставим: обрубок, выданный за цитату, — это уже наше
 * утверждение о том, чего источник не писал. Границы нет — цитаты нет.
 */
function shortenToSentence(quote: string, maxChars: number): string | null {
  const slice = quote.slice(0, maxChars);
  let cut = -1;
  for (const m of slice.matchAll(SENTENCE_END_RE)) cut = m.index + 1;
  if (cut <= 0) return null;
  const short = slice.slice(0, cut).trim();
  return short || null;
}

/** Предел заголовка раздела в схеме: длиннее — обрезаем, а не роняем прогон. */
const SECTION_TITLE_MAX_CHARS = 160;

/**
 * Раздел, в теле которого стоит цитата; лид раздела не имеет.
 *
 * Заголовок обрезается до капа схемы: он приходит из чужого текста, и статья с
 * длинным заголовком раздела иначе детерминированно роняла бы платный прогон
 * исключением `too_big` — единственный отказ стадии, оформленный не состоянием.
 */
function sectionOfQuote(quote: string, sections: readonly ArticleSection[]): string | undefined {
  const title = sections.find((s) => quoteFoundInText(quote, s.body))?.title;
  return title ? title.slice(0, SECTION_TITLE_MAX_CHARS) : undefined;
}

export type ArticleFragmentAuditReport = {
  fragments: WikipediaArticleFragment[];
  dropped: number;
  reasons: string[];
};

/**
 * Проверить выбор модели по тексту самой статьи.
 *
 * Ничего не улучшаем — только снимаем необоснованное, и каждое снятие
 * называется причиной.
 */
export function auditArticleFragments(input: {
  fragments: readonly unknown[];
  articleText: string;
  sections: readonly ArticleSection[];
  maxQuoteChars?: number;
}): ArticleFragmentAuditReport {
  const maxQuote = input.maxQuoteChars ?? WIKIPEDIA_ARTICLE_REVIEW_QUOTE_MAX_CHARS;
  const fragments: WikipediaArticleFragment[] = [];
  const reasons: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  const drop = (reason: string): void => {
    dropped += 1;
    if (!reasons.includes(reason)) reasons.push(reason);
  };

  for (const raw of input.fragments) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const category = WikipediaFragmentCategorySchema.safeParse(item.category);
    if (!category.success) {
      drop("категория фрагмента вне списка");
      continue;
    }
    const gloss = String(item.gloss ?? "").trim().slice(0, WIKIPEDIA_ARTICLE_REVIEW_GLOSS_MAX_CHARS);
    if (gloss.length < 4) {
      drop("подпись фрагмента короче четырёх знаков");
      continue;
    }
    let quote = String(item.quote ?? "").trim();
    if (quote.length > maxQuote) {
      const short = shortenToSentence(quote, maxQuote);
      if (!short) {
        drop("цитата длиннее капа и не укорачивается по границе предложения");
        continue;
      }
      quote = short;
    }
    if (quote.length < WIKIPEDIA_ARTICLE_REVIEW_QUOTE_MIN_CHARS) {
      drop("цитата короче двадцати знаков");
      continue;
    }
    if (!quoteFoundInText(quote, input.articleText)) {
      drop("цитаты нет в тексте статьи");
      continue;
    }
    const key = quote.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    fragments.push({
      quote,
      category: category.data,
      gloss,
      section: sectionOfQuote(quote, input.sections),
    });
    if (fragments.length >= WIKIPEDIA_ARTICLE_REVIEW_MAX_FRAGMENTS) break;
  }

  return { fragments, dropped, reasons };
}

/**
 * Почему модельная часть не выполнится, если не выполнится.
 *
 * Разрешение — ключ, а не флаг: `callOpenAiStrictJson` без ключа отказывает сам,
 * поэтому здесь достаточно офлайн-запрета, а «модель не ответила» приходит
 * отказом вызова. Подставленный вызыватель офлайн-запрет снимает: он и есть
 * ответ на вопрос «куда идти» — в сеть такой прогон не ходит по построению.
 */
function modelSkipReason(
  env: NodeJS.ProcessEnv,
  injectedCaller: boolean
): WikipediaReviewNotReviewedReason | null {
  if (injectedCaller) return null;
  return String(env.NETWORK_CALLS ?? "").trim() === "0" ? "offline" : null;
}

function notReviewed(
  base: Omit<WikipediaArticleReview, "status" | "notReviewedReason" | "subjectMatch" | "fragments">,
  reason: WikipediaReviewNotReviewedReason
): WikipediaArticleReview {
  return {
    ...base,
    subjectMatch: "unclear",
    fragments: [],
    status: "NOT_REVIEWED",
    notReviewedReason: reason,
  };
}

export async function runWikipediaArticleReview(input: {
  caseId: string;
  subject: { fullName: string; aliases?: string[] };
  checks: readonly WikipediaArticleReviewCheck[];
  /**
   * Разборы прошлого прогона этой же джобы.
   *
   * Переиспользуется только **состоявшийся** разбор и только его модельная
   * часть — выбор фрагментов и мнение о принадлежности. Детерминированная часть
   * (лид, разделы) считается по нынешнему снимку, а цитаты проходят аудит
   * заново: покупка — это работа модели, а не текст статьи.
   */
  previous?: readonly WikipediaArticleReview[];
  deps?: { call?: typeof callOpenAiStrictJson; env?: NodeJS.ProcessEnv };
}): Promise<WikipediaArticleReviewSet> {
  const env = input.deps?.env ?? process.env;
  const call = input.deps?.call ?? callOpenAiStrictJson;
  const subjectNames = subjectNameVariants(input.subject);
  const reviews: WikipediaArticleReview[] = [];
  const bought = new Map(
    (input.previous ?? [])
      .filter((r) => r.status === "REVIEWED")
      .map((r) => [r.checkRef, r])
  );

  for (const check of input.checks) {
    const articleText = String(check.articleText ?? "").trim();
    const title = String(check.pageTitle ?? "").trim();
    // Статья без текста записи разбора не заводит: «не разобрали» и «нечего
    // разбирать» — разные состояния, и второе страница уже умеет молчать.
    if (!articleText || !title) continue;

    const parsed = splitArticleText(articleText);
    const reviewedText = articleText.slice(0, WIKIPEDIA_ARTICLE_REVIEW_MAX_INPUT_CHARS);
    const base = {
      checkRef: `inventory:${wikipediaCheckInventoryId(check.id)}`,
      language: String(check.language ?? "").trim() || "ru",
      title,
      url: check.url ?? undefined,
      lead: parsed.lead,
      sections: parsed.sections.map((s) => s.title),
      articleTextChars: articleText.length,
      reviewedChars: reviewedText.length,
      truncated: reviewedText.length < articleText.length,
      audit: { dropped: 0, reasons: [] as string[] },
    };

    /*
     * Купленное сильнее пересборки — но купленным считается только
     * состоявшийся разбор. Артефакт из одних `NOT_REVIEWED` покупкой не был:
     * иначе один транзиентный отказ модели или один офлайн-прогон навсегда
     * фиксировал бы в отчёте «разбор не выполнялся».
     */
    const previous = bought.get(base.checkRef);
    let raw: unknown;
    if (previous) {
      raw = { subjectMatch: previous.subjectMatch, fragments: previous.fragments };
    } else {
      const skip = modelSkipReason(env, Boolean(input.deps?.call));
      if (skip) {
        reviews.push(notReviewed(base, skip));
        continue;
      }
      try {
        raw = await call({
        systemPrompt: SYSTEM_PROMPT,
        userPayload: {
          subject: { fullName: input.subject.fullName, aliases: input.subject.aliases ?? [] },
          article: {
            language: base.language,
            title,
            url: check.url ?? undefined,
            text: reviewedText,
          },
        },
          maxOutputTokens: 1400,
        });
      } catch {
        reviews.push(notReviewed(base, "model-unavailable"));
        continue;
      }
    }

    const body = (raw ?? {}) as Record<string, unknown>;
    const audit = auditArticleFragments({
      fragments: Array.isArray(body.fragments) ? body.fragments : [],
      articleText: reviewedText,
      sections: parsed.sections,
    });
    /*
     * Принадлежность модель может только понизить.
     *
     * Пол — тот же, что у вердиктов прочитанных страниц: нет фамилии субъекта в
     * тексте — «это он» не принимается. Потолка здесь нет вовсе: решение
     * чек-рефа поднимает только детерминированный признак (ФИО в заголовке или
     * наследование по межъязыковой ссылке).
     */
    const claimed = String(body.subjectMatch ?? "unclear");
    const said = ["subject", "likely", "other", "unclear"].includes(claimed)
      ? (claimed as WikipediaArticleReview["subjectMatch"])
      : "unclear";
    const subjectMatch =
      (said === "subject" || said === "likely") && !subjectMentioned(reviewedText, subjectNames)
        ? "unclear"
        : said;

    reviews.push({
      ...base,
      subjectMatch,
      fragments: audit.fragments,
      audit: { dropped: audit.dropped, reasons: audit.reasons },
      status: "REVIEWED",
    });
  }

  return WikipediaArticleReviewSetSchema.parse({
    schemaVersion: WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION,
    caseId: input.caseId,
    reviews,
  });
}

/** Почему купленный разбор нельзя переиспользовать. */
type WikipediaReviewReuseLossReason = "unreadable" | "schema-mismatch" | "invalid" | "foreign-case";

export type WikipediaArticleReviewReuse =
  | { status: "reuse"; result: WikipediaArticleReviewSet; previousDatasetId: string | null }
  | { status: "lost"; reason: WikipediaReviewReuseLossReason; previousReviewCount: number }
  | { status: "none" };

export const WIKIPEDIA_ARTICLE_REVIEW_ARTIFACT = "wikipedia-article-review.json" as const;

/**
 * Купленный разбор прошлого прогона этой же джобы.
 *
 * У разбора нет базы: он живёт только в артефакте, и пересоздать его можно лишь
 * заплатив ещё раз. Правила те же, что у вердиктов, и по той же причине узкие:
 * чужой кейс (скопированный каталог), чужая версия схемы и неразобранное
 * содержимое реюзом не считаются, а пустой артефакт покупкой не был.
 */
export function loadReusableWikipediaArticleReview(
  artifactsDir: string,
  input: { caseId: string }
): WikipediaArticleReviewReuse {
  const path = join(artifactsDir, WIKIPEDIA_ARTICLE_REVIEW_ARTIFACT);
  if (!existsSync(path)) return { status: "none" };

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // Сколько записей было в нечитаемом файле — неизвестно, и выдумывать число
    // нельзя; что файл был и пропал — сказать обязаны.
    return { status: "lost", reason: "unreadable", previousReviewCount: 0 };
  }

  const rawReviews = Array.isArray(raw.reviews) ? raw.reviews : [];
  const previousReviewCount = rawReviews.length;
  // Схема проверяется раньше пустоты: артефакт чужой версии мог хранить записи
  // под другим ключом, и «пустой» он только на наш взгляд.
  if (raw.schemaVersion !== WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION) {
    return { status: "lost", reason: "schema-mismatch", previousReviewCount };
  }
  // Разбор содержимого раньше вопроса о пустоте: нечитаемая запись могла быть
  // покупкой, и молчаливое «терять было нечего» скрыло бы подмену.
  const parsed = WikipediaArticleReviewSetSchema.safeParse(raw);
  if (!parsed.success) return { status: "lost", reason: "invalid", previousReviewCount };
  /*
   * Покупкой был только состоявшийся разбор.
   *
   * У вердиктов неудача даёт пустой массив, и следующий прогон решает заново.
   * У разбора неудача даёт **непустой** массив честных `NOT_REVIEWED` — и без
   * этого условия один транзиентный отказ модели или один офлайн-прогон
   * навсегда фиксировал бы в отчёте «разбор текста статьи не выполнялся»,
   * а вернуть его можно было бы только удалив файл руками.
   */
  if (!parsed.data.reviews.some((r) => r.status === "REVIEWED")) return { status: "none" };
  if (raw.caseId !== input.caseId) {
    return { status: "lost", reason: "foreign-case", previousReviewCount };
  }

  return {
    status: "reuse",
    previousDatasetId: typeof raw.datasetId === "string" ? raw.datasetId : null,
    result: parsed.data,
  };
}

/** Строка о работе разбора для лога прогона. */
export function wikipediaArticleReviewLogLine(set: WikipediaArticleReviewSet): string {
  if (set.reviews.length === 0) {
    return "[digital-profile][википедия] разбирать нечего: текста статей нет";
  }
  const parts = set.reviews.map((r) => {
    if (r.status === "NOT_REVIEWED") return `${r.language}: не разобрано (${r.notReviewedReason})`;
    const dropped = r.audit.dropped > 0 ? `, снято ${r.audit.dropped}` : "";
    return `${r.language}: фрагментов ${r.fragments.length}${dropped}`;
  });
  return `[digital-profile][википедия] ${parts.join("; ")}`;
}
