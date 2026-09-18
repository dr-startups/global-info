/**
 * Цитата источника — одна функция, и она сбалансирована.
 *
 * Отчёт цитирует источники дословно, и цитата в нём — это `«текст» — источник
 * адрес`. Прогон «Чайка» 15.09.2026 встал на воротах целости («цитаты
 * разорваны на 4 страницах»), потому что чужой текст приходит со своими
 * кавычками: вердикт модели начинает цитату внутри газетной ёлочки
 * (`«Назначить Чайку…` — пара осталась за пределами) или заканчивает за ней
 * (`…Мы поможем это устроить» – примерно…`). Восемь мест собирали строку
 * «источник → цитата», ни одно не смотрело на знаки, и ворота были
 * единственной линией.
 *
 * Правило набора: внутри «внешних» кавычек стоят „лапки“. Тело цитаты чистится
 * от обёртки любого стиля, внутренние ёлочки и прямые кавычки становятся
 * лапками по глубине, непарные знаки снимаются. Слова не меняются — только
 * знаки, и только те, что иначе рвут цитату.
 *
 * Два входа — один алгоритм: `sourceQuote` при сборке строки и
 * `normalizeQuoteMarks` на границе паков, где чужая цитата могла приехать
 * уже собранной (аналитика, стадия GPT, обрезка). Так непарная ёлочка
 * невозможна по построению, а ворота остаются последней линией, а не первой.
 */

import type { SlideContentContract } from "../deck-sections/contracts";

const OPEN = "«";
const CLOSE = "»";
const LOW = "„";
const HIGH = "“";

/** Наш же якорь атрибуции: за ним стоит закрывающая кавычка цитаты. */
// Без `\b`: в JavaScript граница слова знает только латиницу, после
// кириллического «источник» её нет — якорь не совпадал бы никогда.
const ATTRIBUTION_ANCHOR = /»\s*[—–-]\s*источник(?!\p{L})/gu;

/** Снять обёртку любого стиля, если она обнимает текст целиком. */
function stripWrapping(text: string): string {
  const pairs: Array<[string, string]> = [
    [OPEN, CLOSE],
    [LOW, HIGH],
    ['"', '"'],
    ["“", "”"],
  ];
  let body = text.trim();
  for (let guard = 0; guard < 3; guard += 1) {
    const pair = pairs.find(([o, c]) => body.startsWith(o) && body.endsWith(c) && body.length >= 2);
    if (!pair) return body;
    const [o, c] = pair;
    if (o === OPEN) {
      // Обёртка — только когда первая « закрывается последней » (глубина
      // возвращается к нулю лишь в конце), иначе это две соседние цитаты.
      let depth = 0;
      let closesEarly = false;
      for (let i = 0; i < body.length; i += 1) {
        if (body[i] === OPEN) depth += 1;
        else if (body[i] === CLOSE) {
          depth -= 1;
          if (depth === 0 && i < body.length - 1) {
            closesEarly = true;
            break;
          }
        }
      }
      if (closesEarly) return body;
    } else if (o === c) {
      if ((body.match(/"/gu) ?? []).length !== 2 && (body.match(/"/gu) ?? []).length % 2 !== 0) return body;
    }
    body = body.slice(o.length, body.length - c.length).trim();
  }
  return body;
}

/**
 * Тело цитаты: внутренние кавычки — лапками по глубине, непарные сняты.
 *
 * Непарная открывающая снимается, а не закрывается: закрыть её значило бы
 * решить за источник, где кончается его цитата. Прямые кавычки считаются по
 * чётности, непарная последняя снимается.
 */
/**
 * Хвостовое многоточие заголовка — маркер обрезки у поисковика (« ...»).
 *
 * Печатается так же, как закрывается оборванная цитата (`closeTail`): «…»,
 * приклеенное к последнему слову. Прежде заголовок шёл как есть — «Глинка ...»
 * с пробелом перед точками, а панель, которой многоточия запрещены, переписывала
 * его в «Глинка. » (шаг 0104). Многоточие в середине — слова источника, не
 * трогается.
 */
const TRAILING_ELLIPSIS_RE = /\s*(?:\.{3}|…)+\s*$/u;

/**
 * Разметка источника, которая словами не является (шаг 0109).
 *
 * Википедия приносит комбинируемые знаки ударения («Серге́евич», «Дерипа́ска»):
 * буква остаётся, надстрочный знак уходит. Сначала NFC — иначе «й» и «ё» в
 * разложенной форме потеряли бы свой диакритик. Пробел перед знаком препинания
 * и после открывающей скобки («( род. 2 января 1968 , Дзержинск )») — след
 * разметки страницы, а не пунктуация источника; многоточие и тире не трогаются:
 * «…» — слова источника (шаг 0104).
 */
export function withoutSourceMarkup(text: string): string {
  return (
    text
      .normalize("NFC")
      .replace(/[\u0300-\u036f]/gu, "")
      .replace(/\s+([,;:.!?)])/gu, "$1")
      .replace(/\(\s+/gu, "(")
      // Пробел внутри ёлочек и лапок — та же разметка страницы: Википедия
      // отдаёт «« Единая Россия »» (шаг 0115). Прямые кавычки не трогаются:
      // у них не видно, открывающая это или закрывающая.
      .replace(/([«„])\s+/gu, "$1")
      .replace(/\s+([»“])/gu, "$1")
      // Потерянный пробел — тоже разметка, а не слова (шаг 0117): ответ Алисы
      // пришёл как «Родился 9мая 1967года», «Бондарчук—советский». Между
      // цифрой и русским словом (две и более буквы: «2х-комнатная» и «3D» не
      // трогаются) и вокруг тире между словами; диапазон чисел «2009—2021»
      // остаётся диапазоном.
      .replace(/(\d)(?=[а-яё]{2})/gu, "$1 ")
      .replace(/(?<=[\p{L})»“"])—(?=[\p{L}(«„"])/gu, " — ")
  );
}

export function quoteBody(text: string): string {
  const src = withoutSourceMarkup(stripWrapping(String(text ?? "")).replace(TRAILING_ELLIPSIS_RE, "…"));
  const out: string[] = [];
  const openStack: number[] = [];
  let straightOpen = false;
  let straightOpenAt = -1;
  for (const ch of src) {
    if (ch === OPEN) {
      openStack.push(out.length);
      out.push(LOW);
    } else if (ch === CLOSE) {
      if (openStack.length > 0) {
        openStack.pop();
        out.push(HIGH);
      }
      // Непарная закрывающая — снимается.
    } else if (ch === '"') {
      if (straightOpen) {
        out.push(HIGH);
        straightOpen = false;
      } else {
        straightOpenAt = out.length;
        out.push(LOW);
        straightOpen = true;
      }
    } else {
      out.push(ch);
    }
  }
  const drop = new Set<number>(openStack);
  if (straightOpen && straightOpenAt >= 0) drop.add(straightOpenAt);
  return out
    .filter((_, i) => !drop.has(i))
    .join("")
    .replace(/\s{2,}/gu, " ")
    .trim();
}

/**
 * Цитаты без двойников по тексту (шаг 0109).
 *
 * Зеркальные страницы (cyclowiki `Олег_Владимирович_Дерипаска` и
 * `Дерипаска,_Олег_Владимирович`) приносят одну и ту же фразу под разными
 * адресами, и резюме печатало её дважды подряд. Ключ — тело цитаты после
 * `quoteBody`, без регистра и кавычек; остаётся первая по порядку.
 */
export function dedupeQuotesByText<T extends { text: string }>(quotes: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const q of quotes) {
    const key = quoteBody(q.text)
      .toLowerCase()
      .replace(/[«»"“”„]/gu, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(q);
  }
  return out;
}

/** Строка-цитата: `«тело»` плюс атрибуция (`sourceAttribution`, может быть пустой). */
export function sourceQuote(text: string, attribution: string): string {
  return `${OPEN}${quoteBody(text)}${CLOSE}${attribution}`;
}

/**
 * Начало цитаты, закрытой якорем атрибуции на позиции `closeAt`: ближайшая
 * слева «, встреченная при пустом стеке; если стек так и не опустел — первая
 * « строки (лишняя закрывающая внутри тела снимется балансировкой).
 */
function openerFor(line: string, closeAt: number): number {
  const stack: number[] = [];
  let first = -1;
  for (let i = closeAt - 1; i >= 0; i -= 1) {
    const ch = line[i];
    if (ch === CLOSE) stack.push(i);
    else if (ch === OPEN) {
      if (stack.length === 0) return i;
      stack.pop();
      first = i;
    }
  }
  return first;
}

function balanceLine(line: string): string {
  if (!line.includes(OPEN) && !line.includes(CLOSE)) return line;
  let out = line;
  // 1. Цитаты с атрибуцией — от последней к первой, чтобы индексы не плыли.
  const anchors = [...out.matchAll(ATTRIBUTION_ANCHOR)].map((m) => m.index ?? -1).filter((i) => i >= 0);
  for (const closeAt of anchors.reverse()) {
    const openAt = openerFor(out, closeAt);
    if (openAt < 0) continue;
    const body = out.slice(openAt + 1, closeAt);
    out = `${out.slice(0, openAt)}${OPEN}${quoteBody(body)}${CLOSE}${out.slice(closeAt + 1)}`;
  }
  // 2. Остаток строки — по стеку: непарная » снимается; непарная « снимается,
  //    если дальше в строке есть другие кавычки, и закрывается многоточием,
  //    если она последняя — обрыв виден, а не выдаётся за наше слово.
  const chars = [...out];
  const stack: number[] = [];
  const drop = new Set<number>();
  chars.forEach((ch, i) => {
    if (ch === OPEN) stack.push(i);
    else if (ch === CLOSE) {
      if (stack.length > 0) stack.pop();
      else drop.add(i);
    }
  });
  let closeTail = false;
  for (const at of stack) {
    const lastQuoteMark = Math.max(chars.lastIndexOf(OPEN), chars.lastIndexOf(CLOSE));
    if (at === lastQuoteMark) closeTail = true;
    else drop.add(at);
  }
  let result = chars.filter((_, i) => !drop.has(i)).join("");
  if (closeTail) result = `${result.replace(/[\s;,:—–-]+$/u, "")}…${CLOSE}`;
  return result;
}

/** Атрибуция после закрывающей кавычки: тире с непустым хвостом. */
function attributionFollows(tail: string): boolean {
  return /^[—–-]\s*\S+/u.test(tail.trim());
}

/** Блок называет источники отдельной строкой — «Где видно: …» / «Источники: …». */
function blockNamesSources(text: string): boolean {
  return /(?:Где видно|Источник(?:и)?(?:\s+в\s+регионе)?):\s*\S+/iu.test(text);
}

/**
 * Цитата без источника не печатается (шаг 0092).
 *
 * Правило то же, что у ворот целости (`quoteIntegrityProblems`): строка не
 * первая (первая — название темы, наше слово), начинается с «, после
 * последней » нет атрибуции, а блок не называет источники строкой «Где
 * видно». Такая строка — утверждение, которое читатель не может проверить:
 * снимается вместе с обещанием над ней («Найдены …:»), если цитат в блоке не
 * осталось. Сеть применяет правило, ворота проверяют, что оно выполнено.
 */
function withoutUnsourcedQuotes(lines: string[]): string[] {
  if (blockNamesSources(lines.join("\n"))) return lines;
  const isQuoteLine = (line: string): boolean => line.trim().startsWith(OPEN);
  const kept = lines.filter((line, index) => {
    if (index === 0 || !isQuoteLine(line)) return true;
    const body = line.replace(/\s*(\[finding-[^\]]*\]\s*)+$/u, "").trim();
    const closing = body.lastIndexOf(CLOSE);
    if (closing <= 0) return true;
    return attributionFollows(body.slice(closing + 1));
  });
  if (kept.length === lines.length) return lines;
  const quoteRemains = kept.some((line, index) => index > 0 && isQuoteLine(line));
  return quoteRemains ? kept : kept.filter((line) => !/:\s*$/u.test(line.trim()));
}

/** Та же чистка для уже собранного текста — построчно, затем правило источника. */
export function normalizeQuoteMarks(text: string): string {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => balanceLine(line));
  return withoutUnsourcedQuotes(lines).join("\n");
}

const TEXT_FIELDS = [
  "narrative",
  "whatWasFound",
  "whyItMatters",
  "whatToCheck",
  "statusNote",
  "sourceNote",
  "methodologyNote",
] as const;

/** Слайд с выправленными кавычками во всех текстовых полях; тот же объект, если править нечего. */
export function normalizeSlideQuoteMarks(slide: SlideContentContract): SlideContentContract {
  let changed = false;
  const content: Record<string, unknown> = { ...(slide.content as Record<string, unknown>) };
  for (const field of TEXT_FIELDS) {
    const value = content[field];
    if (typeof value !== "string") continue;
    const fixed = normalizeQuoteMarks(value);
    if (fixed !== value) {
      content[field] = fixed;
      changed = true;
    }
  }
  if (Array.isArray(content.bullets)) {
    const bullets = (content.bullets as unknown[]).map((b) =>
      typeof b === "string" ? normalizeQuoteMarks(b) : b
    );
    if (bullets.some((b, i) => b !== (content.bullets as unknown[])[i])) {
      content.bullets = bullets;
      changed = true;
    }
  }
  return changed ? { ...slide, content: content as SlideContentContract["content"] } : slide;
}
