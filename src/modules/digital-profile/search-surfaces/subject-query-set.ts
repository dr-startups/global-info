/**
 * Набор запросов, по которым идёт аудит.
 *
 * Предмет аудита — не «весь собранный корпус», а выдача по нескольким запросам,
 * которые реально набирает человек, проверяющий субъекта. Эталон отрасли
 * (разбор — `docs/etalon-orion-razbor.md`) фиксирует пять наиболее популярных
 * производных от ФИО и печатает их на каждой странице отчёта: читатель обязан
 * видеть, по чему смотрели, иначе доля «29% нежелательных ссылок» — число без
 * знаменателя.
 *
 * Популярность берётся у самого поисковика — из подсказок. Механические
 * перестановки ФИО остаются страховкой на случай, когда подсказок нет: отчёт
 * не должен падать из-за отказа одной поверхности.
 *
 * Набор фиксируется датой. Подсказки меняются, и через месяц тот же субъект
 * даст другой набор — поэтому «по состоянию на» относится и к нему тоже.
 *
 * Модуль чистый: ни сети, ни LLM, ни обращения к базе.
 */

import { transliterateRuToEn } from "./orion-query-plan";

export const SUBJECT_QUERY_SET_VERSION = "subject-query-set-v1" as const;

/** Сколько запросов уходит в аудит. Пять — как в эталоне. */
export const SUBJECT_QUERY_LIMIT = 5;

/** Откуда взялся запрос — это часть отчёта, а не служебная пометка. */
export type SubjectQueryOrigin =
  | { kind: "subject_name" }
  | { kind: "name_variant" }
  | { kind: "suggestion"; engine: string; region: string; suggestionRank: number };

export type SubjectQuery = {
  query: string;
  normalized: string;
  origin: SubjectQueryOrigin;
  /** Место в наборе, 1-based. Первым всегда идёт само имя. */
  setRank: number;
};

export type RejectedSubjectQuery = {
  query: string;
  reason:
    | "duplicate"
    | "missing_subject_tokens"
    | "foreign_person"
    | "too_long"
    | "over_limit";
};

export type SubjectQuerySet = {
  version: typeof SUBJECT_QUERY_SET_VERSION;
  subjectFullName: string;
  region: string;
  language: string;
  /** Дата фиксации набора — подсказки меняются, набор обязан иметь дату. */
  capturedAt: string;
  limit: number;
  queries: SubjectQuery[];
  /** Отклонённые кандидаты с причиной: выбор должен быть проверяем. */
  rejected: RejectedSubjectQuery[];
};

export type SubjectQuerySetInput = {
  profile: {
    fullName: string;
    firstName?: string;
    lastName?: string;
    patronymic?: string;
    /** Дополнительные написания имени (транслит, псевдонимы). */
    variants?: string[];
  };
  /** Подсказки поисковика в том порядке, в котором он их вернул. */
  suggestions?: Array<{ text: string; engine: string; region: string; rank: number }>;
  region: string;
  language: string;
  capturedAt: string;
  limit?: number;
};

/** Длиннее этого запрос перестаёт быть тем, что набирает человек. */
const MAX_QUERY_CHARS = 80;

export function normalizeSubjectQuery(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[«»"'`]/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function tokensOf(value: string): string[] {
  const n = normalizeSubjectQuery(value);
  return n ? n.split(" ") : [];
}

/** Написания одного слова, по которым его узнаём и в кириллице, и в латинице. */
function wordForms(word: string): string[] {
  const base = normalizeSubjectQuery(word);
  if (!base) return [];
  const forms = new Set([base]);
  const lat = normalizeSubjectQuery(transliterateRuToEn(base));
  if (lat) forms.add(lat);
  return [...forms];
}

function hasAnyForm(haystack: string[], word: string | undefined): boolean {
  if (!word) return false;
  const forms = wordForms(word);
  return haystack.some((t) => forms.includes(t));
}

/**
 * Отчества и вторые имена, встречающиеся в подсказках.
 *
 * Подсказка «прощание с петербургом михаил иванович глинка» — про однофамильца,
 * и запрос по ней измерял бы чужую выдачу. Признак чужого человека простой:
 * рядом с фамилией стоит имя или отчество, отличные от субъекта.
 */
const RU_PATRONYMIC = /^[\p{L}]+(ович|евич|ьевич|овна|евна|ична|инична)$/u;

function looksLikeForeignPerson(
  tokens: string[],
  profile: SubjectQuerySetInput["profile"]
): boolean {
  const ownFirst = wordForms(profile.firstName ?? "");
  const ownPatronymic = wordForms(profile.patronymic ?? "");
  for (const t of tokens) {
    if (RU_PATRONYMIC.test(t) && ownPatronymic.length > 0 && !ownPatronymic.includes(t)) {
      return true;
    }
  }
  // Чужое имя рядом с фамилией: в подсказке есть отчество субъекта, но имя другое.
  if (ownPatronymic.length > 0 && tokens.some((t) => ownPatronymic.includes(t))) {
    const namedTokens = tokens.filter((t) => RU_PATRONYMIC.test(t) === false);
    const hasOwnFirst = namedTokens.some((t) => ownFirst.includes(t));
    if (ownFirst.length > 0 && !hasOwnFirst) return true;
  }
  return false;
}

/** Перестановки ФИО — страховка, когда подсказок не хватает. */
export function nameVariants(profile: SubjectQuerySetInput["profile"]): string[] {
  const first = (profile.firstName ?? "").trim();
  const last = (profile.lastName ?? "").trim();
  const patronymic = (profile.patronymic ?? "").trim();
  const out: string[] = [];
  if (first && last) out.push(`${first} ${last}`);
  if (last && first) out.push(`${last} ${first}`);
  if (last && first && patronymic) out.push(`${last} ${first} ${patronymic}`);
  if (first && patronymic && last) out.push(`${first} ${patronymic} ${last}`);
  for (const v of profile.variants ?? []) {
    const t = String(v ?? "").trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * Собрать набор запросов аудита.
 *
 * Порядок: сначала имя субъекта как есть — это то, что набирают первым; затем
 * подсказки в порядке популярности; затем перестановки ФИО до лимита.
 */
export function buildSubjectQuerySet(input: SubjectQuerySetInput): SubjectQuerySet {
  const limit = Math.max(1, input.limit ?? SUBJECT_QUERY_LIMIT);
  const profile = input.profile;
  const fullName = String(profile.fullName ?? "").trim();

  const queries: SubjectQuery[] = [];
  const rejected: RejectedSubjectQuery[] = [];
  const seen = new Set<string>();

  const push = (query: string, origin: SubjectQueryOrigin): boolean => {
    const text = query.trim().replace(/\s+/gu, " ");
    if (!text) return false;
    const normalized = normalizeSubjectQuery(text);
    if (!normalized) return false;
    if (seen.has(normalized)) {
      rejected.push({ query: text, reason: "duplicate" });
      return false;
    }
    if (text.length > MAX_QUERY_CHARS) {
      rejected.push({ query: text, reason: "too_long" });
      return false;
    }
    if (queries.length >= limit) {
      rejected.push({ query: text, reason: "over_limit" });
      return false;
    }
    seen.add(normalized);
    queries.push({ query: text, normalized, origin, setRank: queries.length + 1 });
    return true;
  };

  if (fullName) push(fullName, { kind: "subject_name" });

  // Подсказки — в том порядке, в котором их вернул поисковик: он и есть
  // популярность. Пересортировывать по своему вкусу здесь нечем.
  const suggestions = [...(input.suggestions ?? [])].sort((a, b) => a.rank - b.rank);
  for (const s of suggestions) {
    const text = String(s.text ?? "").trim();
    if (!text) continue;
    const tokens = tokensOf(text);
    const hasSurname = hasAnyForm(tokens, profile.lastName) || hasAnyForm(tokens, fullName.split(/\s+/)[0]);
    if (!hasSurname) {
      // Хвост подсказки без фамилии («бизнесмен биография») — это продолжение
      // имени, которое человек уже набрал; дописываем имя обратно.
      const joined = `${fullName} ${text}`.trim();
      const joinedTokens = tokensOf(joined);
      if (looksLikeForeignPerson(joinedTokens, profile)) {
        rejected.push({ query: joined, reason: "foreign_person" });
        continue;
      }
      push(joined, {
        kind: "suggestion",
        engine: s.engine,
        region: s.region,
        suggestionRank: s.rank,
      });
      continue;
    }
    if (looksLikeForeignPerson(tokens, profile)) {
      rejected.push({ query: text, reason: "foreign_person" });
      continue;
    }
    push(text, {
      kind: "suggestion",
      engine: s.engine,
      region: s.region,
      suggestionRank: s.rank,
    });
  }

  for (const variant of nameVariants(profile)) {
    if (queries.length >= limit) break;
    push(variant, { kind: "name_variant" });
  }

  return {
    version: SUBJECT_QUERY_SET_VERSION,
    subjectFullName: fullName,
    region: input.region,
    language: input.language,
    capturedAt: input.capturedAt,
    limit,
    queries,
    rejected,
  };
}

/** Клиентская строка: по каким запросам смотрели и на какую дату. */
export function subjectQuerySetClientLine(set: SubjectQuerySet): string {
  if (set.queries.length === 0) return "";
  const list = set.queries.map((q) => `«${q.query}»`).join(", ");
  const date = set.capturedAt.slice(0, 10).split("-").reverse().join(".");
  return `Проверено ${set.queries.length} ${plural(set.queries.length)}: ${list}. По состоянию на ${date}.`;
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "запрос";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "запроса";
  return "запросов";
}
