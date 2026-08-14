/**
 * Решение по одной прочитанной странице.
 *
 * Модель получает **текст страницы**, а не заголовок из выдачи, и отвечает
 * структурой, а не прозой. Форма решения описана в
 * `contracts/link-verdict.ts`; здесь — как эту форму получают.
 *
 * Что модели НЕ даётся намеренно:
 *
 * — **Наш справочник рубрик.** Тема должна называть то, о чём публикация
 *   («Судебный спор с бывшей супругой»), а не выбираться из восьми готовых
 *   ярлыков. Ровно из-за справочника телеинтервью 2015 года оказалось в теме
 *   «Криминальные / судебные материалы».
 * — **Оценка других страниц.** Каждое решение принимается по своей странице:
 *   иначе одна громкая публикация красит соседние.
 *
 * Что требуется жёстко:
 *
 * — **Цитата под нежелательным выводом.** Без неё вывод — мнение модели, а не
 *   факт со страницы, и он понижается до неясного (`requireQuotedAdverse`).
 * — **Решение о принадлежности.** Однофамилец — главная ошибка таких отчётов,
 *   и модель обязана назвать её прямо, а не растворить в тексте.
 * — **Честность о непрочитанном.** Если страница не открылась, решение по ней
 *   не выдумывается: тональность нейтральная, принадлежность «неясно», причина
 *   записана.
 */

import {
  LINK_VERDICT_SCHEMA_VERSION,
  LinkVerdictSchema,
  requireQuotedAdverse,
  type LinkVerdict,
} from "../contracts/link-verdict";
import { callOpenAiStrictJson } from "../gpt/openai-json-client";
import type { LinkPageRead } from "../../services/link-page-reader";
import { SOURCE_TYPES, normalizeSourceType, sourceTypeFromDomain } from "./source-type";

export const LINK_VERDICT_PROMPT_VERSION = "link-verdict-prompt-v2" as const;

const SYSTEM_PROMPT = `Ты аналитик проверки деловой репутации. Тебе дают текст одной веб-страницы и данные проверяемого лица.

Верни СТРОГО JSON:
{
  "subjectMatch": "subject" | "likely" | "other" | "unclear",
  "tone": "adverse" | "neutral" | "supportive",
  "theme": "<о чём эта публикация, одной фразой на русском, 4-120 знаков>",
  "sourceType": "<что это за площадка, ровно одно значение из списка ниже>",
  "quotes": [{"text": "<дословная цитата со страницы, 10-400 знаков>"}],
  "publishedAt": "<дата публикации, если она есть на странице, иначе не указывай>"
}

Правила:
1. subjectMatch — про то, о ТОМ ЛИ человеке страница. "other" — если это однофамилец или тёзка. "unclear" — если по тексту не определить. Не выдавай предположение за уверенность.
2. tone — как эта публикация выглядит для банка или контрагента при проверке. "adverse" — если она создаёт вопросы: суды, санкции, расследования, конфликты, обвинения. "supportive" — если это официальная или деловая публикация, работающая на репутацию. Иначе "neutral".
3. theme — назови СОДЕРЖАНИЕ публикации, а не её жанр. Плохо: "Криминальные материалы". Хорошо: "Судебный спор с бывшей супругой о разделе активов".
4. sourceType — ровно одно значение из списка: ${SOURCE_TYPES.join(" | ")}. Смотри на саму площадку, а не на тему материала: запись в санкционном реестре и статья о санкциях в газете — разные типы источника.
5. quotes — только дословные фрагменты из данного текста. Если tone="adverse", хотя бы одна цитата обязательна: вывод должен опираться на текст, а не на общее впечатление.
6. Не оценивай другие страницы, о которых можешь знать. Только эту.
7. Если текст не позволяет судить — subjectMatch="unclear", tone="neutral", theme описывает страницу нейтрально.`;

export type LinkVerdictInput = {
  evidenceRef: string;
  url: string;
  domain?: string;
  rank?: number;
  query?: string;
  /** Заголовок и сниппет из выдачи — контекст, но не основание вывода. */
  serpTitle?: string;
  serpSnippet?: string;
  subject: { fullName: string; aliases?: string[] };
  page: LinkPageRead;
};

/** Решение по непрочитанной странице: честное «не знаем», а не догадка. */
export function unreadVerdict(
  input: LinkVerdictInput,
  override?: { failure: "analysis_failed"; detail: string }
): LinkVerdict {
  const failure = override?.failure ?? (input.page.ok ? undefined : input.page.failure);
  const detail = override?.detail ?? (input.page.ok ? undefined : input.page.message);
  return LinkVerdictSchema.parse({
    schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
    evidenceRef: input.evidenceRef,
    url: input.url,
    domain: input.domain,
    rank: input.rank,
    query: input.query,
    subjectMatch: "unclear",
    tone: "neutral",
    theme: (input.serpTitle ?? "Страница не открылась").slice(0, 120) || "Страница не открылась",
    // Страницу не прочитали — тип берём по домену, если он очевиден.
    sourceType: sourceTypeFromDomain(input.domain),
    quotes: [],
    readFailure: failure ?? "not_fetched",
    failureDetail: detail ? String(detail).slice(0, 200) : undefined,
    readAt: input.page.readAt,
  });
}

/**
 * Получить решение по прочитанной странице.
 *
 * Отказ модели — не повод выдумать вывод: он превращается в то же честное
 * «не знаем», что и непрочитанная страница.
 */
export async function analyzeLinkPage(
  input: LinkVerdictInput,
  deps: { call?: typeof callOpenAiStrictJson } = {}
): Promise<LinkVerdict> {
  if (!input.page.ok) return unreadVerdict(input);
  const call = deps.call ?? callOpenAiStrictJson;
  let raw: unknown;
  try {
    raw = await call({
      systemPrompt: SYSTEM_PROMPT,
      userPayload: {
        subject: { fullName: input.subject.fullName, aliases: input.subject.aliases ?? [] },
        page: {
          url: input.url,
          domain: input.domain,
          titleFromPage: input.page.title,
          titleFromSerp: input.serpTitle,
          text: input.page.text,
        },
      },
      maxOutputTokens: 700,
    });
  } catch (err) {
    // Отказ модели — не то же самое, что закрытая страница. Раньше оба случая
    // писались как «not_fetched», и по артефакту нельзя было понять, где чинить.
    return unreadVerdict(input, {
      failure: "analysis_failed",
      detail: err instanceof Error ? err.message : "модель не ответила",
    });
  }

  const body = (raw ?? {}) as Record<string, unknown>;
  const parsed = LinkVerdictSchema.safeParse({
    schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
    evidenceRef: input.evidenceRef,
    url: input.url,
    domain: input.domain,
    rank: input.rank,
    query: input.query,
    subjectMatch: body.subjectMatch,
    tone: body.tone,
    theme: typeof body.theme === "string" ? body.theme.trim().slice(0, 120) : undefined,
    sourceType:
      normalizeSourceType(typeof body.sourceType === "string" ? body.sourceType : undefined) ??
      sourceTypeFromDomain(input.domain),
    quotes: Array.isArray(body.quotes)
      ? body.quotes
          .map((q) => (q && typeof q === "object" ? String((q as { text?: unknown }).text ?? "") : ""))
          .filter((t) => t.trim().length >= 10)
          .slice(0, 3)
          .map((t) => ({ text: t.trim().slice(0, 400) }))
      : [],
    publishedAt:
      typeof body.publishedAt === "string" && body.publishedAt.trim()
        ? body.publishedAt.trim()
        : input.page.publishedAt,
    readAt: input.page.readAt,
  });
  if (!parsed.success) {
    return unreadVerdict(input, {
      failure: "analysis_failed",
      detail: parsed.error.issues[0]?.message ?? "ответ модели не прошёл проверку",
    });
  }
  return requireQuotedAdverse(parsed.data);
}

/**
 * Решения по всем ссылкам страницы выдачи.
 *
 * Порядок сохраняется, чтобы решение можно было положить рядом со строкой
 * таблицы. Параллельность ограничена: страницы читаются с чужих сайтов, и
 * бить по ним пачкой — плохой тон и быстрый бан.
 */
export async function analyzeLinkPages(
  inputs: LinkVerdictInput[],
  deps: { call?: typeof callOpenAiStrictJson; concurrency?: number } = {}
): Promise<LinkVerdict[]> {
  const concurrency = Math.max(1, Math.min(deps.concurrency ?? 4, 8));
  const out: LinkVerdict[] = new Array(inputs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= inputs.length) return;
      out[i] = await analyzeLinkPage(inputs[i]!, deps);
    }
  });
  await Promise.all(workers);
  return out;
}
