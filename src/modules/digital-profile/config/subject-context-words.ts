/**
 * Слова, которыми написан сам субъект, — и почему они не улики.
 *
 * Отчёт 85 (председатель Арбитражного суда Краснодарского края): тема
 * «Криминальные / судебные материалы — высокий, 9 из 9 негативных» сложена из
 * слов его собственной должности. В неё вошли карточка самого суда на
 * `checko.ru`, регламент на `consultant.ru`, досье судьи; подсказки «…судья» и
 * «Какая зарплата в арбитражном суде?» напечатаны как «Потенциально негативные
 * публикации». Отчёт читает сам субъект, и ему предлагали убирать из интернета
 * собственное место работы.
 *
 * Словарь негатива универсален и таким остаётся: «суд» у большинства субъектов
 * означает тяжбу. Меняется не словарь, а вопрос к материалу: **чем именно** он
 * совпал. Совпадение словом, которым оператор описал самого субъекта, ничего о
 * нём не сообщает — это его должность, а не сюжет.
 *
 * Границы правила названы прямо:
 *
 * 1. Маска строится только из фраз `employer` и `position`. `fact` оператор
 *    пишет свободным текстом, и маскировать по нему значило бы дать способ
 *    убрать из отчёта настоящий негатив одной строкой в панели профиля.
 * 2. Материал перестаёт быть негативным, только когда **все** словарные
 *    совпадения в нём — такие слова. Одно чужое слово («прачечная»,
 *    «отмывать», «взятка») возвращает улику целиком.
 * 3. Семейство слова названо явно (`SUBJECT_CONTEXT_FAMILIES`): признак,
 *    написанный словом «суд», выводит и «судью», и «судебный» — иначе досье
 *    судьи осталось бы криминальным материалом. «Судимость» и «судится» в
 *    семейство учреждения не входят: это событие с человеком.
 * 4. Список площадок негатива (санкционные реестры, агрегаторы компромата)
 *    маска не трогает вовсе: там вопрос «кто опубликовал», а не «какими
 *    словами».
 */

import { COURT_INSTITUTION_FORMS } from "./finding-themes";

/**
 * Вход маски — только фразы признаков.
 *
 * Тип узкий намеренно: дата рождения, ИНН и домены маску не строят, и брать
 * сюда весь `SubjectAnchors` значило бы обещать, что они на что-то влияют.
 * Заодно сюда подходит запись решения о персоне, где вид признака хранится
 * строкой.
 */
export type SubjectContextAnchors = {
  phrases: ReadonlyArray<{ kind: string; text: string; strong?: boolean }>;
};

/**
 * Семейства слов, неделимые для маски.
 *
 * Список закрытый и коротким останется: каждая строка — это утверждение
 * «признак, написанный одним словом семейства, объясняет и остальные».
 * Проверяется он началом слова: у семейства своя правая граница внутри.
 */
const SUBJECT_CONTEXT_FAMILIES: ReadonlyArray<RegExp> = [
  new RegExp(`^(?:${COURT_INSTITUTION_FORMS})`, "iu"),
];

/** Виды признаков, слова которых описывают занятие субъекта, а не сюжет о нём. */
const CONTEXT_ANCHOR_KINDS: ReadonlySet<string> = new Set(["employer", "position"]);

/**
 * Падежные окончания — те же, которыми якорь ищется в тексте
 * (`analytics/subject-anchors.ts`). Список повторён здесь намеренно: там он
 * отвечает на вопрос «найден ли признак», здесь — «форма ли это его слова», и
 * общий импорт связал бы два ответа одной строкой без нужды.
 */
const ENDINGS =
  "ого|его|ому|ему|ыми|ими|ами|ями|ах|ях|ов|ев|ей|ой|ый|ий|ая|яя|ое|ее|ые|ие|ом|ем|ам|ям|ую|юю|а|я|у|ю|е|и|ы|о|й|ь";

/** Минимальная длина основы: короче — слово остаётся собой. */
const MIN_STEM = 3;

export type SubjectContextMask = {
  /** Слово целиком: основа признака в любой падежной форме либо его семейство. */
  readonly word: RegExp;
  /** Написания признаков, из которых маска собрана, — для артефактов и отладки. */
  readonly phrases: readonly string[];
};

function norm(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/ё/gu, "е");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stemOf(token: string): string {
  for (const ending of ENDINGS.split("|").sort((a, b) => b.length - a.length)) {
    if (token.length - ending.length >= MIN_STEM && token.endsWith(ending)) {
      return token.slice(0, token.length - ending.length);
    }
  }
  return token;
}

/**
 * Основы значимых слов признака.
 *
 * Порог здесь ниже, чем у поиска якоря в тексте (там слова короче четырёх букв
 * отбрасываются как неразличающие): «суд» — ровно то слово, ради которого
 * маска и заведена, и отбросить его значило бы не сделать ничего.
 */
function contextStems(phrases: readonly string[]): string[] {
  const out: string[] = [];
  for (const phrase of phrases) {
    for (const token of norm(phrase).split(/[^a-zа-я0-9-]+/u)) {
      if (token.length < MIN_STEM) continue;
      const stem = stemOf(token);
      if (stem.length >= MIN_STEM && !out.includes(stem)) out.push(stem);
    }
  }
  return out;
}

const CACHE = new WeakMap<SubjectContextAnchors, SubjectContextMask | null>();

/**
 * Маска признаков субъекта — или `null`, когда признаков занятия нет.
 *
 * `null` означает ровно «маскировать нечего»: поведение всех предикатов при
 * нём прежнее слово в слово, и старые кейсы судятся как раньше.
 */
export function buildSubjectContextMask(
  anchors: SubjectContextAnchors | null | undefined
): SubjectContextMask | null {
  if (!anchors) return null;
  const cached = CACHE.get(anchors);
  if (cached !== undefined) return cached;
  const phrases = anchors.phrases
    .filter((p) => CONTEXT_ANCHOR_KINDS.has(p.kind) && p.text.trim())
    .map((p) => p.text.trim());
  const stems = contextStems(phrases);
  const mask =
    stems.length === 0
      ? null
      : {
          word: new RegExp(
            `^(?:(?:${stems.map(escapeRegExp).join("|")})(?:${ENDINGS})?(?!\\p{L}))`,
            "iu"
          ),
          phrases,
        };
  CACHE.set(anchors, mask);
  return mask;
}

/** Слово целиком, внутри которого стоит совпадение по индексу. */
function wordAt(text: string, index: number): string {
  const isLetter = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);
  let start = index;
  while (start > 0 && isLetter(text[start - 1]!)) start -= 1;
  let end = index;
  while (end < text.length && isLetter(text[end]!)) end += 1;
  return text.slice(start, end);
}

/** Описывает ли это слово самого субъекта — его признаком или его семейством. */
export function isSubjectContextWord(word: string, mask: SubjectContextMask): boolean {
  const value = norm(word);
  if (!value) return false;
  if (mask.word.test(value)) return true;
  return SUBJECT_CONTEXT_FAMILIES.some((family) => family.test(value));
}

/**
 * Все ли совпадения словаря в тексте — слова признаков субъекта.
 *
 * `false`, когда совпадений нет вовсе: ответ «маскировать нечего» и ответ
 * «здесь одна должность» — разные, и путать их нельзя. Спрашивают эту функцию
 * там же, где спрашивают сам словарь, — иначе выбор словаря (полный против
 * сильного подмножества на мягких площадках) пришлось бы повторять вторым
 * ответом.
 */
export function allDictionaryHitsAreSubjectContext(
  text: string,
  dictionary: RegExp,
  mask: SubjectContextMask | null | undefined
): boolean {
  if (!mask) return false;
  const hay = String(text ?? "");
  if (!hay) return false;
  const scan = dictionary.global
    ? new RegExp(dictionary.source, dictionary.flags)
    : new RegExp(dictionary.source, `${dictionary.flags}g`);
  let found = false;
  for (const m of hay.matchAll(scan)) {
    if (m.index === undefined) continue;
    found = true;
    if (!isSubjectContextWord(wordAt(hay, m.index), mask)) return false;
  }
  return found;
}
