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

import { hasCyrillic, transliterateRuToEn } from "./orion-query-plan";
import type { PlannedPrimaryQuery } from "./orion-query-plan";
import { looksLikePatronymic } from "../risk-classifier/entity-disambiguation";

export const SUBJECT_QUERY_SET_VERSION = "subject-query-set-v1" as const;

/** Сколько запросов уходит в аудит. Пять — как в эталоне. */
export const SUBJECT_QUERY_LIMIT = 5;

/**
 * Письменность контура.
 *
 * В выдаче ОАЭ и международного контура запрос набирают латиницей. Кириллица
 * там измеряет не тот интернет: «киркоров филипп бедросович дети» в Google с
 * параметрами ОАЭ возвращает те же русские страницы, что и российский контур,
 * и раздел отчёта об ОАЭ повторяет российский вместо того, чтобы показать, что
 * о субъекте видно за рубежом.
 *
 * Правило одностороннее: в латинском контуре кириллицы быть не должно, а в
 * русском латинский запрос («филипп киркоров instagram») законен и остаётся.
 */
export type QueryScript = "cyrillic" | "latin";

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
    | "over_limit"
    | "wrong_script";
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
  /** По умолчанию выводится из языка контура: `ru` — кириллица, иначе латиница. */
  script?: QueryScript;
};

/** Длиннее этого запрос перестаёт быть тем, что набирает человек. */
const MAX_QUERY_CHARS = 80;

/** Письменность контура: явная, иначе по языку. */
export function scriptForLanguage(language: string, override?: QueryScript): QueryScript {
  if (override) return override;
  return String(language ?? "").toLowerCase().startsWith("ru") ? "cyrillic" : "latin";
}

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
 *
 * Отчество узнаётся общим предикатом — тем же, которым разбирается ФИО.
 * Пока список суффиксов здесь был свой и только кириллический, латинский
 * контур не видел отчества вовсе: подсказка «umar nazarovich kim» — о другом
 * человеке — ушла в платный сбор как запрос о субъекте.
 */
function looksLikeForeignPerson(
  tokens: string[],
  profile: SubjectQuerySetInput["profile"]
): boolean {
  const ownFirst = wordForms(profile.firstName ?? "");
  const ownPatronymic = wordForms(profile.patronymic ?? "");
  const ownSurname = wordForms(profile.lastName ?? "");
  // Собственные имя и фамилия субъекта чужим отчеством быть не могут, даже
  // когда кончаются на «-ович»: иначе «roman abramovich sanctions» — подсказка
  // о самом субъекте — объявляется строкой о другом лице.
  const isOwnName = (t: string): boolean => ownSurname.includes(t) || ownFirst.includes(t);
  for (const t of tokens) {
    if (isOwnName(t)) continue;
    if (looksLikePatronymic(t) && ownPatronymic.length > 0 && !ownPatronymic.includes(t)) {
      return true;
    }
  }
  // Чужое имя рядом с фамилией: в подсказке есть отчество субъекта, но имя другое.
  if (ownPatronymic.length > 0 && tokens.some((t) => ownPatronymic.includes(t))) {
    const namedTokens = tokens.filter((t) => !looksLikePatronymic(t) || isOwnName(t));
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
  const script = scriptForLanguage(input.language, input.script);

  const queries: SubjectQuery[] = [];
  const rejected: RejectedSubjectQuery[] = [];
  const seen = new Set<string>();

  const push = (query: string, origin: SubjectQueryOrigin): boolean => {
    const text = query.trim().replace(/\s+/gu, " ");
    if (!text) return false;
    const normalized = normalizeSubjectQuery(text);
    if (!normalized) return false;
    if (script === "latin" && hasCyrillic(text)) {
      rejected.push({ query: text, reason: "wrong_script" });
      return false;
    }
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
    // Отказ фиксируется по самой подсказке: если сначала дописать к ней имя, в
    // журнале окажется строка, которой поисковик не предлагал.
    if (script === "latin" && hasCyrillic(text)) {
      rejected.push({ query: text, reason: "wrong_script" });
      continue;
    }
    const tokens = tokensOf(text);
    // Фамилия — только разобранная фамилия. Пока рядом стояло «или первое слово
    // имени», условие само повторяло позиционный разбор: у «Умар Назарович
    // Кремлев» подсказка со словом «умар» считалась подсказкой с фамилией.
    const hasSurname = hasAnyForm(tokens, profile.lastName);
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

/**
 * Это само имя субъекта, а не производное написание.
 *
 * Признак — происхождение запроса, а не его место в наборе: первым имя стоит
 * только потому, что его кладут первым, и при пустом `fullName` на первом
 * месте оказалась бы подсказка. Обещание страницы «ТОП-20 по запросу ФИО»
 * держится именно на происхождении.
 */
function isSubjectNameQuery(query: Pick<SubjectQuery, "origin">): boolean {
  return query.origin.kind === "subject_name";
}

/**
 * Набор запросов в том виде, в каком его принимает построитель плана сбора.
 *
 * Здесь пометка «это само имя» покидает модуль и дальше едет данными до деки —
 * тем же путём, что `rank`, `rankSource` и `queryPurpose`. Пока она не
 * покидала набора, таблица выдачи выбирала основной запрос запасным правилом,
 * и на пяти равных написаниях фактически решал алфавит.
 */
export function plannedPrimaryQueries(set: SubjectQuerySet): PlannedPrimaryQuery[] {
  return set.queries.map((q) => ({
    query: q.query,
    ...(isSubjectNameQuery(q) ? { subjectNameQuery: true } : {}),
  }));
}
