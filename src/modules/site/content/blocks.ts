/**
 * Блоки текста страниц сайта: услуг, статей, «О проекте».
 *
 * Строчная разметка одна на весь контент: `**жирный**`, `[текст](/адрес)` и
 * плейсхолдеры `{{…}}`. Ссылки лежат в тексте, а не отдельными полями, потому что в
 * макете они стоят посреди предложения; тест реестра сверяет их адреса со
 * страницами. Страница рисует блоки, JSON-LD читает из них простой текст.
 */

export interface FaqItem {
  q: string;
  a: string;
}

export interface Phase {
  tag: string;
  title: string;
  text: string;
}

export type Block =
  /** Раздел текста; `toc` — подпись в содержании статьи, если раздел туда входит. */
  | { type: "h2"; text: string; toc?: string }
  | { type: "p"; text: string }
  | { type: "ul"; items: readonly string[] }
  /** Список «что будет, если ничего не делать» — карточками, как в макете услуги. */
  | { type: "risks"; items: readonly string[] }
  /** Этапы работы: `rows` — в строку с шагами главной, иначе сеткой. */
  | { type: "phases"; title?: string; items: readonly Phase[]; rows?: boolean }
  | { type: "faq"; items: readonly FaqItem[] }
  /** Группы источников с главной — те же константы, а не копия текста. */
  | { type: "sources" }
  /** Темы находок с главной. */
  | { type: "topics" }
  /** Шаги проверки с главной. */
  | { type: "steps" };

const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/gu;

/** Текст без разметки: для JSON-LD, подсчёта слов и подписей. */
export function plainText(text: string): string {
  return text.replace(LINK, "$1").replace(/\*\*/gu, "");
}

export type InlinePart =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "link"; text: string; href: string }
  | { kind: "placeholder"; text: string };

/** Разбор строчной разметки на части; рисует их `RichText`. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|(\{\{[^}]+\}\})/gu;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ kind: "text", text: text.slice(last, at) });
    if (match[1] !== undefined) parts.push({ kind: "link", text: match[1], href: match[2]! });
    else if (match[3] !== undefined) parts.push({ kind: "strong", text: match[3] });
    else parts.push({ kind: "placeholder", text: match[4]! });
    last = at + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** Все слова, которые человек прочтёт в блоках, — для времени чтения. */
export function blockTexts(blocks: readonly Block[]): string[] {
  return blocks.flatMap((block): string[] => {
    switch (block.type) {
      case "h2":
      case "p":
        return [block.text];
      case "ul":
      case "risks":
        return [...block.items];
      case "phases":
        return [block.title ?? "", ...block.items.flatMap((i) => [i.tag, i.title, i.text])];
      case "faq":
        return block.items.flatMap((i) => [i.q, i.a]);
      case "sources":
      case "topics":
      case "steps":
        return [];
    }
  });
}

export function wordCount(texts: readonly string[]): number {
  return texts
    .map(plainText)
    .join(" ")
    .split(/\s+/u)
    .filter((word) => /[\p{L}\d]/u.test(word)).length;
}
