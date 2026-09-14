/**
 * Карточка персоны подтверждает статью Википедии.
 *
 * Оператор до сбора выбирает персону по карточке внешнего источника; когда
 * карточка — статья Википедии, это и есть ответ на вопрос «о ком статья».
 * До шага 0088 (QA 14.09.2026) ответ до записи проверки Википедии не доходил:
 * лист «Кого проверяли» печатал выбранную карточку, а страница «Википедия»
 * того же отчёта — «принадлежность статьи проверяемому лицу не подтверждена»
 * и не приводила фрагменты. После шага 0054 полное ФИО в заголовке
 * принадлежность не подтверждает, и подтверждать её здесь больше нечему,
 * кроме самой карточки.
 *
 * Решение оператора сильнее мнения модели: разбор статьи может понизить
 * запись до «о другом лице», но про статью, которую оператор выбрал как
 * субъекта, печатается решение оператора — модель не источник правды.
 * Подтверждение наследуется по тому же ребру межъязыковой ссылки, что и
 * понижение: две записи об одной сущности Викиданных не расходятся.
 */

import type { PersonaDecisionRecord } from "./scoped-input";

export type ArticleCheckEntry = {
  kind?: string;
  url?: string;
  title?: string;
  language?: string;
  langlinkOf?: { language?: string; title?: string };
  subjectDecision?: string;
};

/**
 * Ключ статьи: «язык:заголовок» — из адреса (`ru.wikipedia.org/wiki/Заголовок`,
 * после раскодирования процентов, `_` = пробел) либо из языка и заголовка.
 */
export function wikipediaArticleKey(input: {
  url?: string | null;
  language?: string | null;
  title?: string | null;
}): string | null {
  const url = String(input.url ?? "").trim();
  const m = url.match(/^(?:https?:\/\/)?(?:www\.)?([a-z-]+)\.(?:m\.)?wikipedia\.org\/wiki\/([^?#]+)/iu);
  if (m) {
    let title = m[2]!;
    try {
      title = decodeURIComponent(title);
    } catch {
      // Битое кодирование — оставляем как есть: ключ всё равно сравним с собой.
    }
    return `${m[1]!.toLowerCase()}:${title.replace(/_/gu, " ").trim().toLowerCase()}`;
  }
  const language = String(input.language ?? "").trim().toLowerCase().split(/[-_]/u)[0];
  const title = String(input.title ?? "").replace(/_/gu, " ").trim().toLowerCase();
  return language && title ? `${language}:${title}` : null;
}

/**
 * Записи проверки Википедии той же статьи, что выбрана оператором, получают
 * `SUBJECT_MATCH`. Возвращает ключи подтверждённых статей — для журнала.
 */
export function personaConfirmsArticles(
  entries: readonly ArticleCheckEntry[],
  persona: PersonaDecisionRecord | null | undefined
): string[] {
  if (!persona || persona.decision !== "PERSONA_SELECTED" || !persona.selected) return [];
  const selectedKey = wikipediaArticleKey({ url: persona.selected.url });
  if (!selectedKey) return [];

  const checks = entries.filter((e) => e.kind === "wikipedia_check");
  const confirmed: ArticleCheckEntry[] = checks.filter(
    (e) => wikipediaArticleKey({ url: e.url, language: e.language, title: e.title }) === selectedKey
  );
  if (confirmed.length === 0) return [];

  // Ребро ненаправленное: подтверждена любая из двух — вывод относится к обеим.
  const languageOf = (e: ArticleCheckEntry): string =>
    String(e.language ?? "").toLowerCase().split(/[-_]/u)[0] ?? "";
  for (const entry of [...confirmed]) {
    const language = languageOf(entry);
    for (const other of checks) {
      if (other === entry || confirmed.includes(other)) continue;
      const otherLanguage = languageOf(other);
      const linked =
        (language && other.langlinkOf?.language?.toLowerCase() === language) ||
        (otherLanguage && entry.langlinkOf?.language?.toLowerCase() === otherLanguage);
      if (linked) confirmed.push(other);
    }
  }

  const keys: string[] = [];
  for (const entry of confirmed) {
    entry.subjectDecision = "SUBJECT_MATCH";
    const key = wikipediaArticleKey({ url: entry.url, language: entry.language, title: entry.title });
    if (key) keys.push(key);
  }
  return keys;
}
