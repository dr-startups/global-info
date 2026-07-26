/**
 * Порядок имени субъекта в связном тексте (шаг 13, C8).
 *
 * Модель получает имя в анкетном порядке — «Дуров Павел Валерьевич» — и,
 * склоняя его внутри фразы, сохраняет тот же порядок: «профиль Павла Дурова
 * Валерьевича», «связать с Павлом Дуровым Валерьевичем». По-русски в прозе
 * отчество стоит рядом с именем, а не после фамилии, и живой читатель
 * спотыкается на каждой такой фразе.
 *
 * Модуль чистый: ни сети, ни БД, ни модели. Правится только порядок слов,
 * падежи остаются те, что выбрала модель, — они уже верные.
 */

/** Отчество узнаётся по окончанию, падеж значения не имеет. */
const PATRONYMIC_TOKEN = /^\p{Lu}\p{Ll}*(?:ович|евич|ьевич|овна|евна|ьевна|ична|инична)\p{Ll}*$/u;

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Основа слова, общая для всех падежей.
 *
 * «Дуров» → «Дуров» (Дурова, Дуровым, Дурове), «Дурова» → «Дуров»,
 * «Валерьевна» → «Валерьевн» (Валерьевны, Валерьевной).
 */
function stemOf(word: string): string {
  return word.replace(/[аяй]$/u, "");
}

type NameParts = { surname: string; patronymic: string };

/**
 * Фамилия и отчество из отображаемого имени.
 *
 * Отчество опознаётся по окончанию; фамилия — оставшийся край тройки: в
 * анкетном порядке она первая, в естественном — последняя.
 */
export function subjectNameParts(displayName: string): NameParts | null {
  const tokens = String(displayName ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (tokens.length !== 3) return null;
  const patIdx = tokens.findIndex((t) => PATRONYMIC_TOKEN.test(t));
  if (patIdx === 0) return null;
  if (patIdx === 2) return { surname: tokens[0]!, patronymic: tokens[2]! };
  if (patIdx === 1) return { surname: tokens[2]!, patronymic: tokens[1]! };
  return null;
}

/**
 * «Павлом Дуровым Валерьевичем» → «Павлом Валерьевичем Дуровым».
 *
 * Цитаты в кавычках не трогаются: там стоит чужой заголовок, и переставлять в
 * нём слова значит искажать источник.
 */
export function fixSubjectNameOrder(text: string, displayName: string): string {
  const raw = String(text ?? "");
  if (!raw) return raw;
  const parts = subjectNameParts(displayName);
  if (!parts) return raw;

  const sur = escapeRe(stemOf(parts.surname));
  const pat = escapeRe(stemOf(parts.patronymic));
  if (sur.length < 3 || pat.length < 4) return raw;

  const re = new RegExp(
    `(?<!\\p{L})(\\p{Lu}\\p{Ll}+)\\s+(${sur}\\p{Ll}*)\\s+(${pat}\\p{Ll}*)(?!\\p{L})`,
    "gu"
  );

  // Кавычки цитат сохраняются как есть; правится только собственный текст.
  return raw
    .split(/(«[^»]*»)/u)
    .map((chunk) =>
      chunk.startsWith("«")
        ? chunk
        : chunk.replace(re, (whole, first: string, surname: string, patronymic: string) =>
            first.toLowerCase() === surname.toLowerCase()
              ? whole
              : `${first} ${patronymic} ${surname}`
          )
    )
    .join("");
}
