/**
 * Якоря субъекта — признаки, которыми материал подтверждается **сверх ФИО**.
 *
 * Прогон DPA-2026-0049 («Егоров Алексей Евгеньевич», судья, отчёт назван
 * заказчиком «мешаниной»): 585 материалов «о субъекте» принадлежали четырём
 * разным людям — судье, офтальмологу из Подольска, депутату гордумы Краснодара
 * и четырём ИП. Полное совпадение ФИО не различает полных тёзок вообще: у
 * тёзки нет ни чужого отчества, ни чужого имени, то есть конфликта, которым
 * его можно было бы отличить. Различают его признаки — где работает, кем,
 * когда родился, какой у него ИНН, — и они приходят от оператора со слов
 * клиента, а не добываются из того же корпуса, который ими подтверждается.
 *
 * Модуль чистый и офлайновый: ни сети, ни модели. Каждое правило здесь —
 * ответ на вопрос «чем этот текст подтверждает или опровергает принадлежность»,
 * и ответ этот один: якорь оператора либо найден в тексте наблюдения, либо нет.
 */

export type SubjectAnchorKind = "employer" | "position" | "birthPlace" | "education" | "fact";

export type SubjectAnchorPhrase = {
  kind: SubjectAnchorKind;
  text: string;
  /**
   * Сильный якорь подтверждает материал в одиночку. Многословная фраза сильна
   * по умолчанию; однословная — только когда оператор сказал это явно:
   * одно слово («судья») стоит и в чужих текстах, а фраза «Арбитражный суд
   * Краснодарского края» — нет.
   */
  strong: boolean;
};

export type SubjectAnchors = {
  /** Дата рождения кейса, ISO `YYYY-MM-DD`; `null` — оператор её не указал. */
  birthDate: string | null;
  phrases: SubjectAnchorPhrase[];
  /** ИНН, названный оператором. Добытый из корпуса сюда не попадает никогда. */
  inn: string[];
  /** Домены, принадлежащие субъекту или его организации. */
  domains: string[];
};

/**
 * Коды причин, при которых принадлежность материала подтверждена только именем.
 *
 * Набор один на весь продукт: по нему разметка решает, что материал не факт,
 * таблица выдачи — что печатать в оценке, а доля негатива — кого не брать в
 * знаменатель. Пока таких набора было два (в разметке и в построителе выдачи),
 * они совпадали случайно.
 */
export const UNCONFIRMED_SUBJECT_REASONS: ReadonlySet<string> = new Set([
  "full_name_no_anchor",
  "registry_inn_unverified",
]);

/**
 * Коды причин, которые рождаются только в режиме по якорям.
 *
 * По ним отчёт узнаёт, что принадлежность материалов действительно проверяли
 * признаком, а не одним совпадением имени. Чужая дата и чужой ИНН сюда не
 * входят: они работают во всех режимах.
 */
export function isAnchoredReason(reasonCode: string | undefined | null): boolean {
  const code = String(reasonCode ?? "");
  return (
    code.startsWith("full_name_with_anchor:") ||
    code === "full_name_with_weak_anchor" ||
    UNCONFIRMED_SUBJECT_REASONS.has(code)
  );
}

/** Есть ли у профиля хоть один якорь: по этому признаку выбирается лестница. */
export function hasSubjectAnchors(anchors: SubjectAnchors | undefined | null): boolean {
  if (!anchors) return false;
  return Boolean(
    anchors.birthDate ||
      anchors.phrases.some((p) => p.text.trim().length > 0) ||
      anchors.inn.length > 0 ||
      anchors.domains.length > 0
  );
}

/**
 * Сильный признак: тот, которым один человек отличается от полного тёзки.
 *
 * Дата рождения считается — её оператор вводит в карточке кейса всегда, и она
 * работает в обе стороны: подтверждает свой материал и опровергает чужой.
 *
 * Функция стоит здесь, а не рядом с воротами: на вопрос «хватает ли признака»
 * отвечают и ворота на сервере, и форма в кабинете, и ответ у них обязан быть
 * один.
 */
export function hasStrongSubjectAnchor(anchors: SubjectAnchors | null | undefined): boolean {
  if (!anchors) return false;
  return Boolean(
    anchors.birthDate ||
      anchors.inn.length > 0 ||
      anchors.domains.length > 0 ||
      anchors.phrases.some((p) => p.strong && p.text.trim().length > 0)
  );
}

function norm(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/ё/gu, "е");
}

/*
 * Падежные окончания, которыми отделяется основа.
 *
 * Совпадение считается по основе, а не по префиксу: префиксное сравнение
 * делает «судья» частью «судьбы» и приписывает субъекту рязанского депутата
 * (найдено рецензией проекта на реальном корпусе 0049). Основа отделяется
 * только окончанием из этого списка, и остаток слова в тексте проверяется им
 * же — «судьбы» = «судь» + «бы», а «бы» окончанием не является.
 */
const ENDINGS = [
  "ого",
  "его",
  "ому",
  "ему",
  "ыми",
  "ими",
  "ами",
  "ями",
  "ах",
  "ях",
  "ов",
  "ев",
  "ей",
  "ой",
  "ый",
  "ий",
  "ая",
  "яя",
  "ое",
  "ее",
  "ые",
  "ие",
  "ом",
  "ем",
  "ам",
  "ям",
  "ую",
  "юю",
  "а",
  "я",
  "у",
  "ю",
  "е",
  "и",
  "ы",
  "о",
  "й",
  "ь",
].sort((a, b) => b.length - a.length);

/** Минимальная длина основы: короче — слово остаётся собой. */
const MIN_STEM = 3;

/*
 * Тип населённого пункта в якоре не участвует.
 *
 * Оператор пишет «станица Красноармейская», а выдача — «ст.Красноармейской»;
 * требовать слово «станица» значило бы не найти якорь ни на одной странице
 * (проверено на корпусе 0049: 20 строк с «Красноармейск», из них со словом
 * «станица» — три). Список закрытый и состоит только из слов, которые в
 * русском тексте сокращаются точкой.
 */
const LOCALITY_WORDS = new Set([
  "станица",
  "станице",
  "станицы",
  "ст",
  "город",
  "города",
  "городе",
  "гор",
  "г",
  "поселок",
  "поселка",
  "пос",
  "п",
  "село",
  "села",
  "с",
  "деревня",
  "деревни",
  "д",
  "хутор",
  "х",
  "аул",
]);

function tokensOf(text: string): string[] {
  return norm(text)
    .split(/[^a-zа-я0-9-]+/u)
    .map((t) => t.replace(/^-+|-+$/g, ""))
    .filter(Boolean);
}

function stemOf(token: string): string {
  for (const ending of ENDINGS) {
    if (token.length - ending.length >= MIN_STEM && token.endsWith(ending)) {
      return token.slice(0, token.length - ending.length);
    }
  }
  return token;
}

/**
 * Основы значимых слов якорь-фразы.
 *
 * Слова короче четырёх букв отбрасываются: «суд» в «Арбитражный суд
 * Краснодарского края» не различает ничего, а «ст.» — вовсе сокращение.
 */
export function anchorPhraseStems(phrase: string): string[] {
  const out: string[] = [];
  for (const token of tokensOf(phrase)) {
    if (LOCALITY_WORDS.has(token)) continue;
    if (token.length <= 3) continue;
    const stem = stemOf(token);
    if (stem.length >= MIN_STEM && !out.includes(stem)) out.push(stem);
  }
  return out;
}

function tokenMatchesStem(token: string, stem: string): boolean {
  if (token === stem) return true;
  if (!token.startsWith(stem)) return false;
  const tail = token.slice(stem.length);
  return ENDINGS.includes(tail);
}

/**
 * Фраза найдена в тексте, когда найдено **каждое** её значимое слово — в любой
 * падежной форме и в любом месте текста.
 *
 * Предел правила назван прямо: основа не знает смысла, поэтому однокоренное
 * слово того же корня («красноармейскими методами» при якоре «станица
 * Красноармейская») совпадением считается. Панель персон показывает оператору,
 * на каких строках якорь сработал, — это и есть вторая линия защиты.
 */
export function phraseMatchesText(text: string, phrase: string): boolean {
  const stems = anchorPhraseStems(phrase);
  if (stems.length === 0) return false;
  const tokens = tokensOf(text);
  return stems.every((stem) => tokens.some((t) => tokenMatchesStem(t, stem)));
}

const RU_MONTHS = [
  "января",
  "февраля",
  "марта",
  "апреля",
  "мая",
  "июня",
  "июля",
  "августа",
  "сентября",
  "октября",
  "ноября",
  "декабря",
];

const EN_MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

function isoParts(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? "").trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

/** Написания одной даты, которые встречаются в заголовках и сниппетах выдачи. */
export function birthDateForms(iso: string): string[] {
  const p = isoParts(iso);
  if (!p) return [];
  const dd = String(p.d).padStart(2, "0");
  const mm = String(p.m).padStart(2, "0");
  const month = RU_MONTHS[p.m - 1] ?? "";
  const enMonth = EN_MONTHS[p.m - 1] ?? "";
  return [
    `${dd}.${mm}.${p.y}`,
    `${p.d}.${p.m}.${p.y}`,
    `${dd}/${mm}/${p.y}`,
    `${p.y}-${mm}-${dd}`,
    `${p.d} ${month} ${p.y}`,
    `${p.d} ${enMonth} ${p.y}`,
  ].filter((f) => !/\s{2,}|undefined/.test(f));
}

/** Своя дата рождения в тексте — в том написании, в котором она найдена. */
export function birthDateMatch(text: string, iso: string | null | undefined): string | null {
  if (!iso) return null;
  const hay = norm(text);
  for (const form of birthDateForms(iso)) {
    if (hay.includes(norm(form))) return form;
  }
  return null;
}

/*
 * Слово-сигнал: без него число датой рождения не является.
 *
 * «ИП зарегистрирован 23.11.2000» и «указ подписан 17.10.2016» — даты, но не
 * рождения, и объявлять их чужой датой значило бы выбросить из отчёта
 * материалы о самом субъекте.
 */
const BIRTH_CUE = /(родил\p{L}*|рожден\p{L}*|дата\s+рождения|born|birth\s*date|г\.?\s*р\.)/giu;

const DATE_RE = new RegExp(
  [
    "\\d{1,2}[.\\/]\\d{1,2}[.\\/]\\d{2,4}",
    "\\d{4}-\\d{2}-\\d{2}",
    `\\d{1,2}\\s+(?:${RU_MONTHS.join("|")})\\s+\\d{4}`,
    `\\d{1,2}\\s+(?:${EN_MONTHS.join("|")})\\s+\\d{4}`,
  ].join("|"),
  "giu"
);

/** Насколько близко к слову-сигналу должна стоять дата, чтобы быть датой рождения. */
const CUE_WINDOW = 40;

/**
 * Чужие даты рождения в тексте.
 *
 * Пусто, когда своя дата неизвестна (сравнивать не с чем) и когда своя дата на
 * этой же странице найдена: список судей называет много дат, и одна из них —
 * наша.
 */
export function foreignBirthDates(text: string, ownIso: string | null | undefined): string[] {
  if (!ownIso) return [];
  if (birthDateMatch(text, ownIso)) return [];
  const hay = norm(text);
  const own = new Set(birthDateForms(ownIso).map(norm));
  const cues: Array<{ start: number; end: number }> = [];
  for (const m of hay.matchAll(BIRTH_CUE)) {
    if (m.index === undefined) continue;
    cues.push({ start: m.index, end: m.index + m[0].length });
  }
  if (cues.length === 0) return [];

  const out: string[] = [];
  for (const m of hay.matchAll(DATE_RE)) {
    if (m.index === undefined) continue;
    const start = m.index;
    const end = start + m[0].length;
    /*
     * Написание берётся из исходного текста, а не из приведённого: клиенту
     * печатается то, что стоит на странице («16 June 1991», не «16 june 1991»).
     * Приведение сохраняет длину строки (регистр и «ё»→«е» — посимвольные),
     * поэтому границы совпадают.
     */
    const value = text.slice(start, end).trim();
    if (own.has(norm(value))) continue;
    const near = cues.some(
      (c) => (start >= c.end && start - c.end <= CUE_WINDOW) || (c.start >= end && c.start - end <= CUE_WINDOW)
    );
    if (near && !out.includes(value)) out.push(value);
  }
  return out;
}

const INN_COEFFICIENTS_11 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_COEFFICIENTS_12 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
const INN_COEFFICIENTS_10 = [2, 4, 10, 3, 5, 9, 4, 6, 8];

function checkDigit(digits: number[], coefficients: number[]): number {
  const sum = coefficients.reduce((acc, c, i) => acc + c * (digits[i] ?? 0), 0);
  return (sum % 11) % 10;
}

/**
 * Контрольная сумма ИНН.
 *
 * Без неё двенадцатизначным ИНН становится хвост дроби: «площадь
 * 11398.600000000002 м²» на реальной странице реестра давала «ИНН
 * 600000000002» (найдено рецензией проекта).
 */
export function isValidInn(value: string): boolean {
  const v = String(value ?? "").trim();
  if (!/^\d{10}$|^\d{12}$/.test(v)) return false;
  const digits = [...v].map((c) => Number(c));
  if (v.length === 10) return checkDigit(digits, INN_COEFFICIENTS_10) === digits[9];
  return (
    checkDigit(digits, INN_COEFFICIENTS_11) === digits[10] &&
    checkDigit(digits, INN_COEFFICIENTS_12) === digits[11]
  );
}

/** Насколько близко перед числом должно стоять слово, называющее его ИНН. */
const INN_CUE_WINDOW = 40;
const INN_CUE = /(инн|огрнип|огрн|егрип|егрюл|налогоплательщик\p{L}*)/giu;

/**
 * ИНН, названные в тексте.
 *
 * Двенадцать цифр сами по себе ИНН не объявляют: рядом должно стоять слово,
 * которое так их и называет. Иначе номером телефона, счётом и хвостом дроби
 * подтверждалась бы принадлежность материала человеку.
 */
export function innsInText(text: string): string[] {
  const hay = norm(text);
  const cues: number[] = [];
  for (const m of hay.matchAll(INN_CUE)) {
    if (m.index !== undefined) cues.push(m.index + m[0].length);
  }
  if (cues.length === 0) return [];
  const out: string[] = [];
  for (const m of hay.matchAll(/\d{10,12}/gu)) {
    if (m.index === undefined) continue;
    const value = m[0];
    if (!isValidInn(value)) continue;
    const near = cues.some((c) => m.index! >= c && m.index! - c <= INN_CUE_WINDOW);
    if (near && !out.includes(value)) out.push(value);
  }
  return out;
}

export type AnchorHit = {
  /** Что именно совпало: `birth_date`, `inn`, `domain` или вид фразы. */
  kind: string;
  /** Написание, в котором признак найден, — оно и печатается в артефактах. */
  value: string;
  strong: boolean;
};

/**
 * Все якоря, найденные в тексте наблюдения, в порядке убывания силы.
 *
 * Порядок — не украшение: им выбирается код причины решения, и ИНН стоит выше
 * даты рождения, потому что он точнее (дата рождения совпадает у тысяч людей,
 * ИНН — ни у кого).
 */
export function anchorHitsInText(input: {
  text: string;
  url?: string | null;
  anchors: SubjectAnchors;
}): AnchorHit[] {
  const hits: AnchorHit[] = [];
  const hay = norm(input.text);

  const ownInn = input.anchors.inn.find((i) => hay.includes(norm(i)));
  if (ownInn) hits.push({ kind: "inn", value: ownInn, strong: true });

  const date = birthDateMatch(input.text, input.anchors.birthDate);
  if (date) hits.push({ kind: "birth_date", value: date, strong: true });

  const url = norm(input.url ?? "");
  const domain = input.anchors.domains.find((d) => d.trim() && url.includes(norm(d)));
  if (domain) hits.push({ kind: "domain", value: domain, strong: true });

  for (const phrase of input.anchors.phrases) {
    if (!phrase.text?.trim()) continue;
    if (!phraseMatchesText(input.text, phrase.text)) continue;
    hits.push({ kind: phrase.kind, value: phrase.text, strong: phrase.strong });
  }

  return hits.sort((a, b) => Number(b.strong) - Number(a.strong));
}
