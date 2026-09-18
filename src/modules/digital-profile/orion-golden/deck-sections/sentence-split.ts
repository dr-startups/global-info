/**
 * Предложения текста — один ответ на весь модуль.
 *
 * Токенизатор жил двенадцатью копиями (`split(/(?<=[.!?…])\s+/u)`), и ни одна не
 * знала о кавычках: QA MVP 14.09.2026 («Галицкий») пагинатор резюме разрезал
 * цитату «…» по точке внутри ёлочек — на одной странице осталось `«…`, на
 * следующей `…»`, ворота приёмки назвали это разорванной цитатой на трёх
 * страницах и остановили сборку. Повтор ничего не менял: рез детерминирован.
 *
 * Правило: граница предложения — знак `.!?…` и пробел за ним, **вне открытой
 * кавычки**. Считаются «…» и „…“ по глубине (цитата внутри цитаты — обычное
 * дело: «…«политически мотивированных»…»), прямые "…" — по чётности. Непарная
 * кавычка в тексте правило снимает целиком: иначе одна забытая ёлочка склеила
 * бы весь абзац в одно «предложение», а страница с ним не сошлась бы вовсе.
 */

const BOUNDARY = /(?<=[.!?…])\s+/gu;

/*
 * Точка после сокращения или инициала — не конец предложения (шаг 0110).
 *
 * Отчёт Дерипаски 18.09.2026: боковая панель печатала цитату «Оле́г Влади́мирович
 * Дерипа́ска ( род.», блок темы — «2 января 1968, Дзержинск …) — российский
 * предприниматель…» дважды: одно предложение Википедии, разрезанное по «род.».
 * Тот же нож резал «г. Москва», «Ф. С. Бондарчук», «12 тыс. рублей».
 * Словарь короткий и один на модуль; инициал — одиночная буква перед точкой.
 */
const ABBREVIATIONS = new Set(
  (
    "род ум г гг ул пр просп пл д кв стр т тыс млн млрд им св ст п пп см руб коп обл пос гл ч ред изд " +
    "англ лат рус нем фр др тел etc vs st mr mrs dr jr no inc ltd co"
  ).split(" ")
);

function endsWithAbbreviation(text: string, dotAt: number): boolean {
  if (text[dotAt] !== ".") return false;
  const word = /(\p{L}+)$/u.exec(text.slice(0, dotAt))?.[1];
  if (!word) return false;
  return [...word].length === 1 || ABBREVIATIONS.has(word.toLowerCase());
}

type QuoteState = { angle: number; low: number; straight: number; paren: number };

function step(state: QuoteState, ch: string): void {
  if (ch === "«") state.angle += 1;
  else if (ch === "»") state.angle -= 1;
  else if (ch === "„") state.low += 1;
  else if (ch === "“") state.low -= 1;
  else if (ch === '"') state.straight += 1;
  else if (ch === "(") state.paren += 1;
  else if (ch === ")") state.paren -= 1;
}

/** Кавычки текста парны: ёлочки и лапки сходятся к нулю, прямых — чётное число. */
function quotesBalance(text: string): boolean {
  const state: QuoteState = { angle: 0, low: 0, straight: 0, paren: 0 };
  for (const ch of text) {
    step(state, ch);
    if (state.angle < 0 || state.low < 0) return false;
  }
  return state.angle === 0 && state.low === 0 && state.straight % 2 === 0;
}

/** Скобки текста парны: предложение не кончается внутри открытой скобки — если они сходятся. */
function parensBalance(text: string): boolean {
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/** Позиции границ предложений (индекс начала пробела), с учётом кавычек, скобок и сокращений. */
function boundaries(text: string): number[] {
  const guarded = quotesBalance(text);
  const parensGuarded = parensBalance(text);
  const out: number[] = [];
  const state: QuoteState = { angle: 0, low: 0, straight: 0, paren: 0 };
  let scanned = 0;
  for (const m of text.matchAll(BOUNDARY)) {
    const at = m.index ?? 0;
    for (const ch of text.slice(scanned, at)) step(state, ch);
    scanned = at;
    const insideQuotes = state.angle > 0 || state.low > 0 || state.straight % 2 === 1;
    if (guarded && insideQuotes) continue;
    if (parensGuarded && state.paren > 0) continue;
    if (endsWithAbbreviation(text, at - 1)) continue;
    out.push(at);
  }
  return out;
}

/** Предложения текста: по границе `.!?…` + пробел, но не внутри кавычек. Пустых нет, края обрезаны. */
export function splitSentences(text: string): string[] {
  const src = String(text ?? "");
  const out: string[] = [];
  let from = 0;
  for (const at of boundaries(src)) {
    out.push(src.slice(from, at));
    from = at;
  }
  out.push(src.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * Границы частей предложения (`; `, ` — `, `: `, `, `), по которым его можно
 * разложить, не залезая внутрь кавычек. Нужна тому же пагинатору: слишком
 * длинное предложение он раскладывает по частям, и рез внутри «…» рвал бы
 * цитату так же, как рез по точке.
 */
export function splitOutsideQuotes(text: string, boundary: string): string[] {
  const guarded = quotesBalance(text);
  const parts: string[] = [];
  const state: QuoteState = { angle: 0, low: 0, straight: 0, paren: 0 };
  let from = 0;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith(boundary, i)) {
      const inside = state.angle > 0 || state.low > 0 || state.straight % 2 === 1;
      if (!guarded || !inside) {
        parts.push(text.slice(from, i));
        i += boundary.length;
        from = i;
        continue;
      }
    }
    step(state, text[i]!);
    i += 1;
  }
  parts.push(text.slice(from));
  return parts;
}
