/**
 * Что за источник стоит за строкой выдачи.
 *
 * Читателю отчёта важно не только, что материал есть, но и где он лежит:
 * запись в санкционном реестре, статья в федеральном СМИ и пост в блоге
 * требуют разной реакции, хотя в таблице выглядят одинаково. Столбец с типом
 * источника отвечает на этот вопрос до перехода по ссылке.
 *
 * Тип определяет модель, читающая страницу (`link-verdict-analyst.ts`): она
 * видит содержимое, а не только адрес. Домен остаётся запасным вариантом для
 * страниц, которые прочитать не удалось: у известных площадок тип очевиден и
 * без чтения, а выдумывать его для остальных нельзя — там честнее прочерк.
 *
 * Модуль чистый: ни сети, ни модели.
 */

/** Закрытый список: свободные формулировки в таблице не сравнить между собой. */
export const SOURCE_TYPES = [
  "Новостное СМИ",
  "Блог / личный сайт",
  "Соцсеть",
  "Видеохостинг",
  "Энциклопедия / справочник",
  "Официальный сайт / госресурс",
  "База данных / реестр",
  "Агрегатор / каталог",
  "Форум",
  "Магазин / маркетплейс",
  "Другое",
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

const BY_DOMAIN: Array<{ pattern: RegExp; type: SourceType }> = [
  { pattern: /(^|\.)(wikipedia\.org|ruwiki\.ru|cyclowiki\.org|britannica\.com)$/iu, type: "Энциклопедия / справочник" },
  { pattern: /(^|\.)(youtube\.com|youtu\.be|rutube\.ru|vimeo\.com|ok\.ru)$/iu, type: "Видеохостинг" },
  {
    pattern: /(^|\.)(vk\.com|vk\.ru|facebook\.com|instagram\.com|t\.me|telegram\.me|x\.com|twitter\.com|linkedin\.com|tiktok\.com)$/iu,
    type: "Соцсеть",
  },
  { pattern: /(^|\.)(dzen\.ru|zen\.yandex\.ru|livejournal\.com|blogspot\.com|medium\.com|teletype\.in)$/iu, type: "Блог / личный сайт" },
  {
    pattern: /(^|\.)(opensanctions\.org|sanctionssearch\.ofac\.treas\.gov|treasury\.gov|data\.europa\.eu|rupep\.org|peps\.dossier\.center|opencorporates\.com|rusprofile\.ru|list-org\.com|checko\.ru|audit-it\.ru)$/iu,
    type: "База данных / реестр",
  },
  { pattern: /(\.|^)(gov|gouv|gob)(\.[a-z]{2,3})?$|(^|\.)(gov\.[a-z]{2}|council\.gov\.ru|kremlin\.ru|pnp\.ru)$/iu, type: "Официальный сайт / госресурс" },
  { pattern: /(^|\.)(forum|otvet\.mail\.ru|pikabu\.ru|reddit\.com)/iu, type: "Форум" },
  { pattern: /(^|\.)(ozon\.ru|wildberries\.ru|avito\.ru|amazon\.[a-z.]+)$/iu, type: "Магазин / маркетплейс" },
];

/** Тип по домену — только там, где он однозначен. Иначе молчим. */
export function sourceTypeFromDomain(domain: string | undefined): SourceType | undefined {
  const host = String(domain ?? "")
    .trim()
    .toLowerCase()
    .replace(/^www\./u, "");
  if (!host) return undefined;
  for (const rule of BY_DOMAIN) {
    if (rule.pattern.test(host)) return rule.type;
  }
  return undefined;
}

/** Значение из закрытого списка, если модель вернула именно его. */
export function normalizeSourceType(value: string | undefined): SourceType | undefined {
  const raw = String(value ?? "").trim();
  if (!raw) return undefined;
  return SOURCE_TYPES.find((t) => t.toLowerCase() === raw.toLowerCase());
}

/**
 * Тип источника для строки таблицы: сначала решение модели, затем домен.
 * Когда не знает ни то ни другое — прочерк, а не догадка.
 */
export function resolveSourceType(input: {
  fromVerdict?: string;
  domain?: string;
}): SourceType | undefined {
  return normalizeSourceType(input.fromVerdict) ?? sourceTypeFromDomain(input.domain);
}
