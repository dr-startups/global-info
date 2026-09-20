/**
 * Телефон заявки: страна, маска и международный номер.
 *
 * До 20.09.2026 поле принимало любую строку, а отказ схемы человек видел только
 * после «Отправить заявку» — до этого мусор в поле выглядел принятым (галочка
 * заполненности стоит у всякого непустого поля). Теперь номер набирается по
 * маске выбранной страны, и поле само знает, готов номер или нет.
 *
 * Список стран — не «все страны мира»: это те, откуда к нам приходят, плюс
 * «другая страна» со свободным вводом. Своей копии правил тут нет — собранный
 * номер всё равно проверяет схема ручки (`self-check/schemas.ts`), здесь только
 * форма ввода и ответ «номер набран целиком».
 */

export interface PhoneCountry {
  /** Код ISO-3166-1 alpha-2; `OTHER` — свободный ввод. */
  id: string;
  name: string;
  /** Телефонный код без «+»; у «другой страны» пуст — он входит в набранное. */
  dial: string;
  /** Шаблон национального номера, `#` — цифра. Пусто — маски нет. */
  mask: string;
  /** Пример для подсказки под полем. */
  example: string;
}

export const OTHER_PHONE_COUNTRY = "OTHER";
export const DEFAULT_PHONE_COUNTRY = "RU";

/** Свободный ввод: столько цифр принимает схема ручки вместе с кодом страны. */
const FREE_MIN_DIGITS = 8;
const FREE_MAX_DIGITS = 15;

export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { id: "RU", name: "Россия", dial: "7", mask: "### ###-##-##", example: "900 123-45-67" },
  { id: "KZ", name: "Казахстан", dial: "7", mask: "### ###-##-##", example: "701 123-45-67" },
  { id: "BY", name: "Беларусь", dial: "375", mask: "## ###-##-##", example: "29 123-45-67" },
  { id: "UA", name: "Украина", dial: "380", mask: "## ###-##-##", example: "67 123-45-67" },
  { id: "UZ", name: "Узбекистан", dial: "998", mask: "## ###-##-##", example: "90 123-45-67" },
  { id: "KG", name: "Киргизия", dial: "996", mask: "### ###-###", example: "700 123-456" },
  { id: "AM", name: "Армения", dial: "374", mask: "## ###-###", example: "77 123-456" },
  { id: "AZ", name: "Азербайджан", dial: "994", mask: "## ###-##-##", example: "50 123-45-67" },
  { id: "GE", name: "Грузия", dial: "995", mask: "### ## ## ##", example: "555 12 34 56" },
  { id: "MD", name: "Молдова", dial: "373", mask: "## ###-###", example: "60 123-456" },
  { id: "TR", name: "Турция", dial: "90", mask: "### ### ## ##", example: "532 123 45 67" },
  { id: "AE", name: "ОАЭ", dial: "971", mask: "## ### ####", example: "50 123 4567" },
  { id: "IL", name: "Израиль", dial: "972", mask: "## ###-####", example: "50 123-4567" },
  { id: "DE", name: "Германия", dial: "49", mask: "", example: "151 23456789" },
  { id: OTHER_PHONE_COUNTRY, name: "Другая страна", dial: "", mask: "", example: "+1 202 555 0123" },
];

const BY_ID = new Map(PHONE_COUNTRIES.map((country) => [country.id, country]));

/** Неизвестный код — «другая страна»: со свободным вводом номер всё равно уйдёт. */
export function phoneCountry(id: string): PhoneCountry {
  return BY_ID.get(id) ?? BY_ID.get(OTHER_PHONE_COUNTRY)!;
}

export function phoneDigits(value: string): string {
  return value.replace(/\D/gu, "");
}

function countHashes(mask: string): number {
  return [...mask].filter((char) => char === "#").length;
}

/**
 * Номер по маске страны. Разделитель ставится, только когда за ним есть цифра:
 * иначе у недобранного номера в конце висел бы дефис.
 */
export function phoneMasked(id: string, value: string): string {
  const country = phoneCountry(id);
  const digits = phoneDigits(value);
  if (!country.mask) return digits.slice(0, FREE_MAX_DIGITS);
  let out = "";
  let next = 0;
  for (const char of country.mask) {
    if (next >= digits.length) break;
    if (char === "#") {
      out += digits[next]!;
      next += 1;
    } else {
      out += char;
    }
  }
  return out;
}

/** Номер набран целиком — по длине маски, а у свободного ввода по пределам схемы. */
export function phoneComplete(id: string, value: string): boolean {
  const country = phoneCountry(id);
  const digits = phoneDigits(value);
  if (!country.mask) {
    const all = digits.length + phoneDigits(country.dial).length;
    return all >= FREE_MIN_DIGITS && all <= FREE_MAX_DIGITS;
  }
  return digits.length === countHashes(country.mask);
}

/** Код страны и номер одной строкой: то, что уходит на сервер и попадает к менеджеру. */
export function phoneE164(id: string, value: string): string {
  const digits = phoneDigits(value);
  if (!digits) return "";
  return `+${phoneDigits(phoneCountry(id).dial)}${digits}`;
}
