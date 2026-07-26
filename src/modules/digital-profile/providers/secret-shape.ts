/**
 * Форма секрета: настроен ключ или там стоит заглушка (шаг 04.2).
 *
 * `/api/digital-profile/providers` показывал:
 *
 *     GOOGLE   kind=REAL   status=ENABLED   supportsRealCalls=true   missingConfigKeys=[]
 *
 * при том что `SERPER_API_KEY` содержал `<<<FILL>>>`. Готовность проверялась
 * непустотой строки, поэтому любое мусорное значение читалось как валидный
 * ключ. Оператор видел зелёный статус и узнавал правду из пустого отчёта —
 * то есть после того, как прогон уже потрачен.
 *
 * Статус `ENABLED` обязан означать «проверено», а не «переменная не пуста».
 *
 * Правила намеренно консервативны: ложное срабатывание здесь выключает
 * работающего провайдера, что хуже пропущенной заглушки. Поэтому по точному
 * совпадению отсеиваются только слова, которыми настоящий ключ быть не может,
 * а по вхождению — только явные маркеры незаполненного шаблона.
 */

/** Значения, которыми настоящий ключ не бывает (сравнение целиком). */
const PLACEHOLDER_EXACT = new Set([
  "changeme",
  "change-me",
  "change_me",
  "todo",
  "fixme",
  "placeholder",
  "dummy",
  "none",
  "null",
  "nil",
  "undefined",
  "example",
  "test",
  "secret",
  "key",
  "apikey",
  "api-key",
  "api_key",
  "yourkey",
  "your-key",
  "your_key",
  "xxx",
  "xxxx",
  "n/a",
  "-",
]);

/** Маркеры шаблона в исходной записи (скобки и подстановки). */
const PLACEHOLDER_SYNTAX: RegExp[] = [
  /<{2,}|>{2,}/u, // <<<FILL>>>
  /^\s*<[^<>]+>\s*$/u, // <your-api-key>
  /\$\{[^}]*\}/u, // ${SERPER_API_KEY}
];

/**
 * Словесные маркеры шаблона.
 *
 * Проверяются по записи, где `-` и `_` заменены пробелом: в JavaScript
 * подчёркивание — буквенный символ, поэтому `\b` внутри `PASTE_YOUR_KEY_HERE`
 * границы не находит, и правило молча не срабатывало бы.
 */
const PLACEHOLDER_WORDS: RegExp[] = [
  /\bchange me\b/u,
  /\breplace (me|this|with)\b/u,
  /\bpaste (your|here|it)\b/u,
  /\bfill (me|in|here|this)\b/u,
  /\byour (api )?(key|token|secret)\b/u,
  /\b(insert|enter) (your|key|token)\b/u,
];

/**
 * Ниже этой длины строка ключом быть не может.
 *
 * Самый короткий ключ среди используемых провайдеров — 32 символа, поэтому
 * порог в 8 не задевает ни одного настоящего значения и снимает «xxx», «abc»,
 * «1234» и подобное.
 */
const MIN_SECRET_LENGTH = 8;

/** Почему значение не считается настроенным ключом; `null` — считается. */
export type SecretDefect = "empty" | "placeholder" | "too_short";

export function secretDefect(value: string | null | undefined): SecretDefect | null {
  const raw = String(value ?? "").trim();
  if (!raw) return "empty";
  if (PLACEHOLDER_EXACT.has(raw.toLowerCase())) return "placeholder";
  if (PLACEHOLDER_SYNTAX.some((re) => re.test(raw))) return "placeholder";
  const words = raw.toLowerCase().replace(/[-_]+/gu, " ");
  if (PLACEHOLDER_WORDS.some((re) => re.test(words))) return "placeholder";
  // Строка из одного повторяющегося символа — «xxxxxxxxxx», «0000000000».
  if (/^(.)\1+$/u.test(raw)) return "placeholder";
  if (raw.length < MIN_SECRET_LENGTH) return "too_short";
  return null;
}

/** Настроен ли секрет по-настоящему. */
export function isConfiguredSecret(value: string | null | undefined): boolean {
  return secretDefect(value) === null;
}

/**
 * Значение секрета или пустая строка, если это заглушка.
 *
 * Позволяет вызывающему коду сохранить прежнюю форму проверки (`if (!key)`),
 * не повторяя разбор заглушек у себя.
 */
export function configuredSecret(value: string | null | undefined): string {
  return isConfiguredSecret(value) ? String(value).trim() : "";
}

/** Человеческое объяснение, что не так с ключом. */
export function secretDefectMessage(key: string, defect: SecretDefect): string {
  switch (defect) {
    case "empty":
      return `${key} не задан`;
    case "placeholder":
      return `${key} содержит заглушку, а не ключ`;
    case "too_short":
      return `${key} короче любого настоящего ключа`;
  }
}
