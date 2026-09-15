/**
 * Числа и даты экранов проверки по-русски.
 *
 * Даты печатаются в часовом поясе браузера: «Проверка от 12 сентября, 14:32»
 * человек сверяет со своими часами, а не с часами сервера.
 */

/** Форма слова для числа: «1 материал», «2 материала», «5 материалов». */
export function plural(n: number, forms: readonly [one: string, few: string, many: string]): string {
  const mod10 = Math.abs(n) % 10;
  const mod100 = Math.abs(n) % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

export function materialsText(n: number): string {
  return `${n} ${plural(n, ["материал", "материала", "материалов"])}`;
}

/** Предложный падеж после «в»: «в 1 теме», «в 2 темах». */
export function themesInText(n: number): string {
  return `${n} ${plural(n, ["теме", "темах", "темах"])}`;
}

function parts(iso: string, options: Intl.DateTimeFormatOptions, timeZone?: string) {
  const list = new Intl.DateTimeFormat("ru-RU", { ...options, timeZone }).formatToParts(new Date(iso));
  return (type: Intl.DateTimeFormatPartTypes) => list.find((p) => p.type === type)?.value ?? "";
}

/** «12 сентября 2026, 14:32». */
export function formatCheckDate(iso: string, timeZone?: string): string {
  const get = parts(
    iso,
    { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
    timeZone
  );
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}`;
}

/** «12 октября 2026». */
export function formatDay(iso: string, timeZone?: string): string {
  const get = parts(iso, { day: "numeric", month: "long", year: "numeric" }, timeZone);
  return `${get("day")} ${get("month")} ${get("year")}`;
}

/**
 * Дата рождения из формы или карточки: «1985-03-12» → «12.03.1985». Санкционные
 * базы знают и неполные даты — «1985-03» печатается «03.1985», а не выдумывается
 * день.
 */
export function formatBirthDate(value: string): string {
  return value.split("-").reverse().join(".");
}
