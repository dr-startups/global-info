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
 * Заголовок служебного блока выдачи — не публикация.
 *
 * «Картинки по запросу "Тимати биография"» — это подпись, которую поисковик
 * рисует над плиткой изображений. Автора у неё нет, содержания тоже: она лишь
 * повторяет запрос. На прогоне 14.08 такая строка стояла доказательством в
 * пяти блоках отчёта, в том числе в резюме для руководства и в матрице рисков.
 *
 * Перечислены формы всех поверхностей, которые собирает конвейер, — картинки,
 * видео, новости, похожие и связанные запросы, — в русском и английском виде:
 * страница ОАЭ отдаёт те же блоки по-английски.
 */
const SURFACE_BLOCK_HEADING =
  /^\s*(?:картинки|изображения|видео|новости|товары|карты)\s+по\s+запросу(?!\p{L})|^\s*(?:похожие|связанные|другие)\s+(?:запросы|результаты)(?!\p{L})|^\s*(?:images|videos|news|results)\s+for(?!\p{L})|^\s*(?:people\s+also\s+(?:ask|search\s+for)|related\s+searches|searches\s+related\s+to)(?!\p{L})/iu;

export function looksLikeSurfaceBlockHeading(text: string | null | undefined): boolean {
  return SURFACE_BLOCK_HEADING.test(String(text ?? ""));
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

/**
 * Цитата со страницы, годная для клиента.
 *
 * Заголовок выдачи поисковик режет по своей ширине, и в отчёте появлялись
 * обрывки — «…бизнес, личная», «…в отношении него после», «lost his mansion in
 * Germany due». Прочитанная страница даёт другое: целые предложения, которые
 * аудитор вдобавок сверил с текстом дословно. Их и надо цитировать.
 *
 * Но не всё, что модель выделила цитатой, является фразой. С табличных
 * страниц приходят выгрузки вида «События Участие в организациях 26 События ИП
 * 2 Санкции 83» — набор ярлыков и чисел, из которого читатель не поймёт
 * ничего. Такие отсеиваются по доле числовых слов: у предложения их единицы, у
 * выгрузки — четверть и больше.
 *
 * Пустая строка означает «цитировать нечего»; вызывающий берёт следующий
 * источник или обходится без цитаты.
 */
/**
 * Машинная выгрузка, а не фраза.
 *
 * В отчёте 72 трижды стояло: «Темы: судебные и правовые материалы… источники:
 * ext_gb_coh_psc, us_trade_csl, eu_fsf, ru_billionaires_2021, ru_navalny35» —
 * идентификаторы наборов данных, поданные клиенту в кавычках как слова
 * источника. Признак надёжный: в человеческой прозе подчёркивание между
 * буквами не встречается, а в машинном имени оно и есть разделитель.
 */
const MACHINE_IDENTIFIER = /(?:^|\s)[\p{L}\d]+_[\p{L}\d_]+(?=\s|[,.;:)]|$)/u;

export function looksLikeMachineDump(text: string | null | undefined): boolean {
  return MACHINE_IDENTIFIER.test(String(text ?? ""));
}

export function pageQuoteForClient(text: string | null | undefined): string {
  const body = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (body.length < MIN_PAGE_QUOTE_CHARS) return "";
  if (looksLikeSearchQuery(body) || looksLikeSurfaceBlockHeading(body)) return "";
  if (looksLikeMachineDump(body)) return "";
  const tokens = body.split(" ").filter(Boolean);
  if (tokens.length < MIN_PAGE_QUOTE_WORDS) return "";
  const numeric = tokens.filter((t) => NUMERIC_TOKEN.test(t)).length;
  if (numeric / tokens.length > MAX_NUMERIC_SHARE) return "";
  if (DANGLING_QUOTE_TAIL.test(body)) return "";
  // Относительное слово в самом хвосте — признак, что предложение продолжалось:
  // «…theft of state property, which». Точки в конце не требуем: из ста сорока
  // годных цитат прогона её имеют пятьдесят восемь процентов, а остальные
  // кончаются законченными оборотами — «…признавшим дело сфабрикованным».
  if (!/[.!?»]$/u.test(body) && RELATIVE_TAIL.test(body)) return "";
  return body;
}

/** Короче этого цитата не несёт мысли, а только обрывок. */
const MIN_PAGE_QUOTE_CHARS = 40;
const MIN_PAGE_QUOTE_WORDS = 8;
/** Доля слов-чисел, выше которой это выгрузка таблицы, а не фраза. */
const MAX_NUMERIC_SHARE = 0.2;
const NUMERIC_TOKEN = /^[^\p{L}]*\d[\d.,()\u2013\u2014-]*[^\p{L}]*$/u;
/**
 * Висящий хвост в конце цитаты. Границы через `\p{L}`: `\b` в JavaScript
 * определён на ASCII и кириллический предлог не находит.
 */
const RELATIVE_TAIL =
  /(?:^|[^\p{L}])(?:which|that|who|whose|where|when|because|котор(?:ый|ая|ое|ые|ого|ой|ом|ому|ым|ыми|ых|ую)|чей|потому|поскольку|если|чтобы|хотя)(?:\s+\S+)?\s*$/iu;
const DANGLING_QUOTE_TAIL =
  /(?:^|[^\p{L}\p{N}_])(?:и|в|во|на|по|с|со|о|об|из|из-за|для|как|что|за|к|ко|у|от|до|про|при|после|перед|the|of|and|or|to|in|on|at|for|with|from|by|due)\s*$/iu;
