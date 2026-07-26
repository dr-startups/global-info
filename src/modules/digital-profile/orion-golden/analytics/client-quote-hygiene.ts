/**
 * Гигиена цитируемого материала (шаг 13, C4).
 *
 * В отчёт попадали куски, которые в due diligence цитировать нельзя:
 *
 *     «… Pavel Durov Co-founder, CEO, Telegram at Oslo Freedom Forum 2026:
 *     Join this channel to get access to perks: https://www.youtube.com/channel»
 *     — источник youtube.com
 *
 * Это описание ролика с призывом подписаться и голым адресом канала, и стояло
 * оно в разделе «Офшоры и финансовая прозрачность». Читателю — банку,
 * инвестору, партнёру — такой фрагмент не сообщает ничего и подрывает доверие
 * ко всему документу.
 *
 * Модуль чистый: ни сети, ни БД, ни модели. Правила консервативны — режется
 * только то, что заведомо является рекламной обвязкой площадки, а не содержанием.
 */

/** Рекламная обвязка площадок: всё от неё и до конца строки — не содержание. */
const PROMO_TAIL = new RegExp(
  [
    "join this channel",
    "subscribe to (?:my|our|the) channel",
    "подпис(?:ывайтесь|ка) на канал",
    "ставьте лайк",
    "get access to perks",
    "smash that like",
    "ссылка в описании",
    "link in bio",
    "промокод",
    "реклама\\.?\\s*erid",
  ].join("|"),
  "iu"
);

/** Голый адрес внутри клиентской прозы: ссылки живут в трассе, не в тексте. */
const BARE_URL = /\bhttps?:\/\/\S+/giu;

/** Хвост из хештегов — тоже обвязка площадки. */
const HASHTAG_TAIL = /(?:\s#[\p{L}\p{N}_]+){2,}\s*$/giu;

/** Минимальная длина осмысленного фрагмента после чистки. */
const MIN_MEANINGFUL_CHARS = 25;

/**
 * Убирает рекламную обвязку, сохраняя содержательную часть.
 *
 * Если промо начинается в середине — оставляем всё до него: до призыва
 * подписаться обычно и стоит то, ради чего материал попал в выборку.
 */
export function stripPromotionalTail(text: string | null | undefined): string {
  let value = dropGluedSecondFragment(text);
  const promo = PROMO_TAIL.exec(value);
  if (promo && promo.index >= 0) value = value.slice(0, promo.index);
  value = value.replace(BARE_URL, " ").replace(HASHTAG_TAIL, " ");
  return value.replace(/\s+/gu, " ").replace(/[\s,;:—-]+$/u, "").trim();
}

/**
 * Отбрасывает второй фрагмент, приклеенный через « ... ».
 *
 * Провайдеры отдают обрезанный заголовок и следом — второй кусок того же
 * ролика, часто на другом языке:
 *
 *     «Павел Дуров СЛУЧАЙНО сделал экосистему для онлайн казино ...
 *      Pavel Durov ACCIDENTALLY created an ecosystem for online casinos»
 *
 * Читателю это выглядит как сбой. Многоточие в окружении пробелов — маркер
 * склейки; многоточие в конце («…и личная жизнь...») это обычная обрезка и
 * здесь не трогается.
 */
export function dropGluedSecondFragment(text: string | null | undefined): string {
  const value = String(text ?? "").trim();
  const marker = value.indexOf(" ... ");
  if (marker < 0) return value;
  const head = value.slice(0, marker).trim();
  const tail = value.slice(marker + 5).trim();
  // Оба куска должны быть содержательными: иначе это не склейка, а пунктуация.
  if (head.length < 40 || tail.length < 15) return value;
  return head;
}

/**
 * Годится ли фрагмент как цитируемое доказательство.
 *
 * Отсеиваются: пустое после чистки; слишком короткое, чтобы быть утверждением;
 * строка целиком из адреса; поисковая строка в нижнем регистре без знаков
 * препинания — такое цитировать нельзя, это запрос пользователя, а не публикация.
 */
export function isQuotableEvidence(text: string | null | undefined): boolean {
  const cleaned = stripPromotionalTail(text);
  if (cleaned.length < MIN_MEANINGFUL_CHARS) return false;
  if (!/[\p{L}]/u.test(cleaned)) return false;
  return true;
}

/**
 * Похож ли текст на поисковый запрос, а не на заголовок публикации.
 *
 * Признаки: всё в нижнем регистре, нет конечной пунктуации, нет кавычек и
 * длина как у запроса. «pavel valeryevich durov arrested», «дуров суд сегодня»
 * — это строки автодополнения, и подавать их как материал нельзя (шаг 13, C2).
 */
export function looksLikeSearchQuery(text: string | null | undefined): boolean {
  const value = String(text ?? "").trim();
  if (!value || value.length > 80) return false;
  if (/[.!?»"']$/u.test(value)) return false;
  if (/[«»"„”]/u.test(value)) return false;
  const letters = value.replace(/[^\p{L}]/gu, "");
  if (!letters) return false;
  // Хотя бы одна заглавная буква — признак заголовка, а не строки поиска.
  return letters === letters.toLowerCase();
}
