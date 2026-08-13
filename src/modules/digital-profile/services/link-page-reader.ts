/**
 * Чтение страницы по ссылке из ТОП-20.
 *
 * Аудит до сих пор судит о материале по заголовку и сниппету — по двум
 * строкам, которые показал поисковик. Чтобы вывод был о содержании, страницу
 * надо открыть. Этот модуль открывает и отдаёт текст; решение по тексту
 * принимается отдельно (`contracts/link-verdict.ts`).
 *
 * Правила, заложенные здесь:
 *
 * — **Неудача — это результат, а не пустота.** Страница может не открыться:
 *   сайт закрыт для роботов, адрес умер, ответ пустой. Эталон отрасли пишет
 *   об этом прямо («из 20 ссылок 2 нежелательные, 7 неактуальных и 2 — не
 *   открываются»), и мы записываем причину тем же способом.
 * — **Ограничения жёсткие.** Таймаут и предел размера заданы здесь, а не
 *   оставлены на волю сети: отчёт не должен зависеть от одного медленного
 *   сайта.
 * — **Ничего не выполняется.** Скрипты и стили вырезаются до текста; мы
 *   читаем страницу, а не запускаем её.
 * — **Сеть по умолчанию выключена.** Модуль ходит наружу только когда это
 *   включено явно: чтение стоит денег, и решение о трате принимает человек.
 */

import type { z } from "zod";
import type { LinkReadFailureSchema } from "../orion-golden/contracts/link-verdict";

type LinkReadFailure = z.infer<typeof LinkReadFailureSchema>;

export const LINK_PAGE_READ_TIMEOUT_MS = 12_000;
/** Больше этого со страницы не берём: тексту статьи столько не нужно. */
export const LINK_PAGE_MAX_BYTES = 1_500_000;
/** Предел извлечённого текста — вход модели, а не архив страницы. */
export const LINK_PAGE_MAX_CHARS = 12_000;

export type LinkPageRead =
  | { ok: true; url: string; text: string; title?: string; publishedAt?: string; readAt: string }
  | { ok: false; url: string; failure: LinkReadFailure; message: string; readAt: string };

/** Включено ли живое чтение страниц. Выключено, пока не разрешили явно. */
export function isLinkReadingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.DIGITAL_PROFILE_LINK_READING ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

const DROP_BLOCKS = /<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi;
const TAGS = /<[^>]+>/g;
const ENTITIES: Record<string, string> = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&laquo;": "«",
  "&raquo;": "»",
  "&mdash;": "—",
  "&ndash;": "–",
};

/** Текст страницы без разметки: скрипты и стили выбрасываются целиком. */
export function extractReadableText(html: string, maxChars = LINK_PAGE_MAX_CHARS): string {
  let text = html.replace(DROP_BLOCKS, " ").replace(TAGS, " ");
  for (const [entity, char] of Object.entries(ENTITIES)) {
    text = text.split(entity).join(char);
  }
  text = text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/gu, " ")
    .trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Заголовок страницы — то, что написано в `<title>`, а не то, что показал поисковик. */
export function extractPageTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  if (!m) return undefined;
  const title = extractReadableText(m[1] ?? "", 300);
  return title || undefined;
}

/**
 * Дата публикации из разметки.
 *
 * Берём только явно объявленную дату (`article:published_time`, `datePublished`),
 * а не первую попавшуюся в тексте: «12 мая» в теле статьи может быть чем угодно,
 * и назвать это датой публикации значит выдумать факт.
 */
export function extractPublishedAt(html: string): string | undefined {
  const patterns = [
    /<meta[^>]+property=["']article:published_time["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']pubdate["'][^>]+content=["']([^"']+)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    const value = m?.[1]?.trim();
    if (value) return value;
  }
  return undefined;
}


/**
 * Что страница сама говорит о себе роботам.
 *
 * Половина отказов на живом прогоне — не блокировка, а пустой ответ: `vk.ru`,
 * `dzen.ru`, `rbc.ru` и им подобные рисуют содержимое скриптами уже в
 * браузере, и в исходном HTML текста нет. Но эти же сайты кладут в разметку
 * описание для поисковиков — `og:description`, `description`, `articleBody`
 * из JSON-LD. Это опубликовано самой страницей и предназначено ровно для
 * чтения машиной.
 *
 * Такой текст короче статьи, и решение по нему слабее. Зато оно основано на
 * том, что страница написала о себе, а не на заголовке из выдачи.
 */
export function extractPublishedSummary(html: string): string {
  const patterns = [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{40,})["']/i,
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{40,})["']/i,
    /"articleBody"\s*:\s*"([^"]{40,})"/i,
    /"description"\s*:\s*"([^"]{40,})"/i,
  ];
  const parts: string[] = [];
  for (const re of patterns) {
    const m = html.match(re);
    const value = m?.[1]?.trim();
    if (value) parts.push(extractReadableText(value, 2000));
  }
  return [...new Set(parts)].join(" ").trim();
}

type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal; headers?: Record<string, string>; redirect?: "follow" }
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * Прочитать одну страницу.
 *
 * Возвращает либо текст, либо названную причину отказа — третьего не дано:
 * «пусто» без причины в отчёте о должной осмотрительности неотличимо от
 * «проверено, ничего нет».
 */
export async function readLinkPage(
  url: string,
  deps: { fetchImpl?: FetchLike; now?: () => Date; timeoutMs?: number } = {}
): Promise<LinkPageRead> {
  const readAt = (deps.now?.() ?? new Date()).toISOString();
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) {
    return { ok: false, url, failure: "not_fetched", message: "fetch недоступен в этой среде", readAt };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? LINK_PAGE_READ_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: "follow",
      // Представляемся честно. Сайт вправе отказать роботу, и такой отказ мы
      // записываем как есть — выдавать себя за браузер, чтобы обойти защиту,
      // не будем: это чужое решение о доступе к их страницам.
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "DigitalProfileAudit/1.0 (репутационный аудит; чтение публичных страниц)",
      },
    });
    if (!res.ok) {
      const failure: LinkReadFailure =
        res.status === 404 || res.status === 410 ? "not_found" : "blocked";
      return { ok: false, url, failure, message: `HTTP ${res.status}`, readAt };
    }
    const html = await res.text();
    if (html.length > LINK_PAGE_MAX_BYTES) {
      return {
        ok: false,
        url,
        failure: "empty_text",
        message: `страница больше предела (${html.length} байт)`,
        readAt,
      };
    }
    let text = extractReadableText(html);
    if (text.length < 200) {
      // Страница отрисовывается скриптами: берём то, что она сама published
      // для роботов. Меньше статьи, но это её собственные слова.
      const summary = extractPublishedSummary(html);
      if (summary.length >= 200) text = summary;
    }
    if (text.length < 200) {
      return { ok: false, url, failure: "empty_text", message: "текста на странице нет", readAt };
    }
    return {
      ok: true,
      url,
      text,
      title: extractPageTitle(html),
      publishedAt: extractPublishedAt(html),
      readAt,
    };
  } catch (err) {
    const aborted = err instanceof Error && /abort/i.test(err.name + err.message);
    return {
      ok: false,
      url,
      failure: aborted ? "timeout" : "not_fetched",
      message: err instanceof Error ? err.message.slice(0, 200) : "неизвестная ошибка",
      readAt,
    };
  } finally {
    clearTimeout(timer);
  }
}
