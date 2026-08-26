/**
 * Stage R1.1.3 — subject identity matching and namesake guards.
 *
 * PURE. Used by the search-result classifier and highlight resolver to avoid
 * treating registry/social/biography rows — or other people with the same surname
 * — as adverse hits on the audit subject.
 */

import { transliterateRuToLat } from "../orion-golden/identity/transliterate-ru";

export type IdentityConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface SubjectIdentity {
  fullName: string;
  surname: string | null;
  givenName: string | null;
  patronymic: string | null;
}

export interface NormalizedSubjectIdentity {
  ruFullName: string;
  ruLastName: string | null;
  ruFirstName: string | null;
  ruPatronymic: string | null;
  normalizedRuTokens: string[];
  latinTransliterations: string[];
  strictNameTokens: string[];
  weakNameTokens: string[];
  expectedPatronymic: string | null;
  disallowedPatronymicSignals: string[];
  regionHints: string[];
  hasLatinAliases: boolean;
}

export type EntityMatchDecision =
  | "strict_subject"
  | "likely_subject"
  | "possible_subject"
  | "namesake"
  | "not_subject"
  | "insufficient_identity";

export interface EntityMatchResult {
  decision: EntityMatchDecision;
  confidence: number;
  reasons: string[];
  matchedTokens: string[];
  missingCriticalTokens: string[];
  conflictingTokens: string[];
  patronymicStatus: "match" | "missing" | "conflict" | "not_applicable";
  regionStatus: "match" | "weak" | "conflict" | "unknown";
}

const PATRONYMIC_SUFFIXES =
  "александрович|георгиевич|михайлович|николаевич|владимирович|сергеевич|андреевич|петрович|иванович|романович|олегович|дмитриевич|викторович|юрьевич|анатольевич|borisovich|константинович";

const PATRONYMIC_RE = new RegExp(
  `(?:^|[\\s,.(—–-])([а-яёa-z]+)\\s+(${PATRONYMIC_SUFFIXES})`,
  "gi"
);

/**
 * Patronymic suffixes — a deliberately narrow list, Cyrillic and Latin.
 *
 * Bare "ич" is NOT here, and the reason is the second user of this predicate:
 * the suggestion filter (subject-query-set) reads any patronymic that is not
 * the subject's own as a sign of another person. With bare "ич" a Balkan
 * surname inside a suggestion — "сидоров и вучич переговоры" — becomes a
 * foreign patronymic, and a legitimate paid query about the subject is thrown
 * away. A "-ович" word in FIRST position is handled by a different rule: the
 * patronymic is only looked for from the second token on.
 */
const PATRONYMIC_TOKEN_RE =
  /(ович|евич|ьевич|овна|евна|ична|инична|ovich|evich|yevich|ovna|evna|ichna)$/i;

/**
 * Surname suffixes used only to order a two-token name.
 *
 * The Latin list carries no "-in": it would make "Kevin Martin" surname-first,
 * and a Western name is given-first. The length floor is there for "Eva" —
 * three letters ending in "eva" — while a transliterated surname ("Tinkov",
 * "Kremlev") is longer. Both are needed: a confirmed Latin alias arrives in the
 * "Surname Given" order, and on "Tinkov Oleg" a Cyrillic-only list called the
 * given name a surname again.
 */
const RU_SURNAME_SUFFIX = /(ов|ев|ин|ын|ский|цкая|ова|ева|ина)$/i;
const LAT_SURNAME_SUFFIX = /(ov|ev|ova|eva|sky|skaya)$/i;
const LAT_SURNAME_MIN_LENGTH = 5;

function looksLikeSurname(token: string): boolean {
  const t = normToken(token);
  return (
    RU_SURNAME_SUFFIX.test(t) ||
    (t.length >= LAT_SURNAME_MIN_LENGTH && LAT_SURNAME_SUFFIX.test(t))
  );
}

/** Does the token look like a patronymic — by suffix, not by its place. */
export function looksLikePatronymic(token: string): boolean {
  return PATRONYMIC_TOKEN_RE.test(normToken(token));
}

/**
 * Parses a full name into surname / given / patronymic parts.
 *
 * The part order is decided BY THE PATRONYMIC, not by position. A purely
 * positional split called "Умар" the surname of "Умар Назарович Кремлев": the
 * whole paid collection then searched for "Назарович Умар", and the guard that
 * drops a query without a surname passed it, because it looked for "Умар".
 *
 * The patronymic is only looked for from the second token on: in first
 * position a "-ович" word is a surname ("Джокович Новак Иванович").
 *
 * Every field holds ONE token. Anything beyond three parts — "оглы"/"кызы", a
 * second surname — stays in fullName only: a field with a space inside is
 * compared to a page as a substring ("кремлев оглы" is never found next to
 * "Кремлев") and to the tokens of a search suggestion never at all, so the
 * subject's own materials would turn into a namesake's. The paid query builders
 * put those tokens back from fullName, and that is where they matter.
 */
export function parseSubjectName(fullName: string): SubjectIdentity {
  const trimmed = fullName.trim().replace(/\s+/g, " ");
  const parts = trimmed.split(" ").filter(Boolean);
  if (parts.length >= 3) {
    if (looksLikePatronymic(parts[1]!)) {
      // "Given Patronymic Surname".
      return {
        fullName: trimmed,
        surname: parts[2]!,
        givenName: parts[0]!,
        patronymic: parts[1]!,
      };
    }
    // "Surname Given Patronymic", and the same when no patronymic is visible.
    return {
      fullName: trimmed,
      surname: parts[0]!,
      givenName: parts[1]!,
      patronymic: parts[2]!,
    };
  }
  if (parts.length === 2) {
    // A two-token name declares no order, so the suffix decides: "Тиньков Олег"
    // and "Tinkov Oleg" are surname-first, "Anders Holmström" is not.
    const surnameFirst = looksLikeSurname(parts[0]!);
    return {
      fullName: trimmed,
      surname: surnameFirst ? parts[0]! : parts[1]!,
      givenName: surnameFirst ? parts[1]! : parts[0]!,
      patronymic: null,
    };
  }
  return { fullName: trimmed, surname: parts[0] ?? null, givenName: null, patronymic: null };
}

function normToken(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").trim();
}

function transliterateRuToken(token: string): string {
  // Таблица общая с профилем субъекта и классификатором: копия, разошедшаяся в
  // одной букве, ломает сверку транслитераций молча.
  return transliterateRuToLat(normToken(token)).replace(/[^a-z0-9]/g, "");
}

function tokenize(value: string): string[] {
  return normToken(value)
    .split(/[^a-zа-я0-9]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

function hasToken(hay: string, token: string): boolean {
  return !!token && hay.includes(token);
}

function dedupeTokens(tokens: string[]): string[] {
  return [...new Set(tokens.filter(Boolean))];
}

export function buildNormalizedSubjectIdentity(input: {
  fullName: string;
  aliases?: string[];
  nationality?: string | null;
  country?: string | null;
  regionHints?: string[];
}): NormalizedSubjectIdentity {
  const parsed = parseSubjectName(input.fullName);
  const ruTokens = dedupeTokens([
    ...tokenize(input.fullName),
    ...(input.aliases ?? []).flatMap((a) => tokenize(a)),
  ]);
  const strictNameTokens = dedupeTokens(
    [parsed.surname, parsed.givenName, parsed.patronymic]
      .filter((x): x is string => Boolean(x))
      .flatMap((x) => tokenize(x))
  );
  const weakNameTokens = dedupeTokens(
    [
      parsed.surname ?? "",
      parsed.givenName ?? "",
      ...((input.aliases ?? []).filter(Boolean) as string[]),
    ]
      .flatMap((x) => tokenize(x))
      .filter((x) => !strictNameTokens.includes(x))
  );
  const latinTransliterations = dedupeTokens(
    strictNameTokens
      .map((x) => transliterateRuToken(x))
      .concat(
        (input.aliases ?? [])
          .flatMap((a) => tokenize(a))
          .filter((x) => /^[a-z]/.test(x))
      )
  );
  const expectedPatronymic = parsed.patronymic ? normToken(parsed.patronymic) : null;
  const disallowedPatronymicSignals = expectedPatronymic
    ? dedupeTokens(
        patronymicsInText((input.aliases ?? []).join(" "))
          .filter((p) => p !== expectedPatronymic)
          .concat(
            // common leakage token: Romanovich with mismatched first/surname context
            expectedPatronymic === "романович" || expectedPatronymic === "romanovich"
              ? []
              : ["romanovich", "романович"]
          )
      )
    : [];
  const regionHints = dedupeTokens([
    ...(input.regionHints ?? []),
    input.nationality ?? "",
    input.country ?? "",
  ]);

  return {
    ruFullName: input.fullName.trim(),
    ruLastName: parsed.surname,
    ruFirstName: parsed.givenName,
    ruPatronymic: parsed.patronymic,
    normalizedRuTokens: ruTokens,
    latinTransliterations,
    strictNameTokens,
    weakNameTokens,
    expectedPatronymic,
    disallowedPatronymicSignals,
    regionHints,
    hasLatinAliases: latinTransliterations.length > 0,
  };
}

export function evaluateEntityMatch(input: {
  text: string;
  subject: NormalizedSubjectIdentity;
  region?: string | null;
  sourceType?: "organic" | "image" | "video" | "wikipedia" | "knowledge" | "compliance" | "other";
}): EntityMatchResult {
  const hay = normToken(input.text);
  const hayAscii = hay.replace(/[^a-z0-9\s]/g, " ");
  const matchedTokens = input.subject.strictNameTokens.filter((t) => hasToken(hay, t));
  const surnameLatin = input.subject.ruLastName ? transliterateRuToken(input.subject.ruLastName) : "";
  const firstLatin = input.subject.ruFirstName ? transliterateRuToken(input.subject.ruFirstName) : "";
  const patLatin = input.subject.ruPatronymic ? transliterateRuToken(input.subject.ruPatronymic) : "";
  const hasSurname = input.subject.ruLastName
    ? hasToken(hay, normToken(input.subject.ruLastName)) ||
      (surnameLatin.length >= 3 && hasToken(hayAscii, surnameLatin))
    : false;
  const hasFirst = input.subject.ruFirstName
    ? hasToken(hay, normToken(input.subject.ruFirstName)) ||
      (firstLatin.length >= 3 && hasToken(hayAscii, firstLatin))
    : false;
  const hasPat = input.subject.expectedPatronymic
    ? hasToken(hay, input.subject.expectedPatronymic) ||
      patronymicsInText(input.text).some((p) => p === input.subject.expectedPatronymic) ||
      (patLatin.length >= 3 && hasToken(hayAscii, patLatin))
    : false;
  const mentionedPatronymics = patronymicsInText(input.text);
  const conflictingPatronymic = Boolean(
    input.subject.expectedPatronymic &&
      mentionedPatronymics.length > 0 &&
      mentionedPatronymics.some((p) => p !== input.subject.expectedPatronymic)
  );
  const patronymicStatus: EntityMatchResult["patronymicStatus"] = input.subject.expectedPatronymic
    ? conflictingPatronymic
      ? "conflict"
      : hasPat
        ? "match"
        : "missing"
    : "not_applicable";

  const region = String(input.region ?? "").toUpperCase();
  const regionStatus: EntityMatchResult["regionStatus"] =
    !region || input.subject.regionHints.length === 0
      ? "unknown"
      : input.subject.regionHints.some((h) => region.includes(h.toUpperCase()))
        ? "match"
        : region === "INTERNATIONAL" || region === "UAE"
          ? "weak"
          : "conflict";

  const conflictingTokens: string[] = [];
  if (conflictingPatronymic) conflictingTokens.push("patronymic_conflict");
  if (hasSurname && input.subject.ruFirstName && !hasFirst) conflictingTokens.push("first_name_conflict");
  if (input.subject.expectedPatronymic && !hasSurname && hasPat) conflictingTokens.push("patronymic_only");

  const missingCriticalTokens: string[] = [];
  if (input.subject.ruLastName && !hasSurname) missingCriticalTokens.push("last_name");
  if (input.subject.ruFirstName && !hasFirst) missingCriticalTokens.push("first_name");
  if (input.subject.expectedPatronymic && !hasPat) missingCriticalTokens.push("patronymic");

  const intlStrict = region === "INTERNATIONAL" || region === "UAE";

  if (conflictingPatronymic) {
    return {
      decision: "namesake",
      confidence: 0.05,
      reasons: ["patronymic_conflict"],
      matchedTokens,
      missingCriticalTokens,
      conflictingTokens,
      patronymicStatus,
      regionStatus,
    };
  }
  if (hasSurname && input.subject.ruFirstName && !hasFirst) {
    return {
      decision: "not_subject",
      confidence: 0.05,
      reasons: ["first_name_conflict"],
      matchedTokens,
      missingCriticalTokens,
      conflictingTokens,
      patronymicStatus,
      regionStatus,
    };
  }
  if (!hasSurname && hasPat) {
    return {
      decision: "insufficient_identity",
      confidence: 0.1,
      reasons: ["patronymic_only_without_surname"],
      matchedTokens,
      missingCriticalTokens,
      conflictingTokens,
      patronymicStatus,
      regionStatus,
    };
  }
  if (hasSurname && hasFirst && (hasPat || patronymicStatus === "not_applicable")) {
    return {
      decision: "strict_subject",
      confidence: 0.95,
      reasons: ["surname_first_patronymic_match"],
      matchedTokens,
      missingCriticalTokens,
      conflictingTokens,
      patronymicStatus,
      regionStatus,
    };
  }
  if (hasSurname && hasFirst) {
    return {
      decision: intlStrict ? "possible_subject" : "likely_subject",
      confidence: intlStrict ? 0.62 : 0.74,
      reasons: ["surname_first_match_patronymic_missing"],
      matchedTokens,
      missingCriticalTokens,
      conflictingTokens,
      patronymicStatus,
      regionStatus,
    };
  }
  if (hasSurname && hasPat) {
    return {
      decision: intlStrict ? "possible_subject" : "likely_subject",
      confidence: intlStrict ? 0.58 : 0.7,
      reasons: ["surname_patronymic_match"],
      matchedTokens,
      missingCriticalTokens,
      conflictingTokens,
      patronymicStatus,
      regionStatus,
    };
  }
  if (hasSurname || hasFirst) {
    return {
      decision: "insufficient_identity",
      confidence: 0.25,
      reasons: ["single_name_token_only"],
      matchedTokens,
      missingCriticalTokens,
      conflictingTokens,
      patronymicStatus,
      regionStatus,
    };
  }
  return {
    decision: "insufficient_identity",
    confidence: 0.0,
    reasons: ["no_subject_tokens"],
    matchedTokens,
    missingCriticalTokens,
    conflictingTokens,
    patronymicStatus,
    regionStatus,
  };
}

function containsToken(text: string, token: string | null): boolean {
  if (!token) return false;
  const t = normToken(token);
  return normToken(text).includes(t);
}

/** Extracts patronymics mentioned in free text (lowercase stem). */
export function patronymicsInText(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(PATRONYMIC_RE.source, "gi");
  while ((m = re.exec(text)) !== null) {
    if (m[2]) out.add(normToken(m[2]));
  }
  return [...out];
}

/**
 * True when the text clearly refers to a different person (other given name /
 * patronymic) while sharing the subject surname.
 */
export function isLikelyNamesake(text: string, subject: SubjectIdentity | null): boolean {
  if (!subject?.surname) return false;
  const hay = normToken(text);
  if (!containsToken(hay, subject.surname)) return false;

  const subjectPat = subject.patronymic ? normToken(subject.patronymic) : null;
  const mentioned = patronymicsInText(text);
  if (subjectPat && mentioned.length > 0) {
    return mentioned.some((p) => p !== subjectPat);
  }

  if (subject.givenName) {
    const given = normToken(subject.givenName);
    const surname = normToken(subject.surname);
    // The case is read off the original text, so "ё" is folded by a replacement
    // of the same length: positions and capitals stay where they were.
    const cased = text.replace(/ё/g, "е").replace(/Ё/g, "Е");
    const re = new RegExp(
      `${surname}[\\s,.(—–-]+([а-яА-Я]{3,})(?:\\s+[а-яА-Я]{3,})?`,
      "i"
    );
    const m = cased.match(re);
    const capturedRaw = m?.[1] ?? null;
    const captured = capturedRaw ? normToken(capturedRaw) : null;
    if (
      captured &&
      captured !== given &&
      captured !== surname &&
      captured.length >= 4 &&
      capturedRaw !== null &&
      looksLikeGivenNameToken(capturedRaw)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A word after the surname passes for another person's given name only when it
 * is capitalised and not written in full caps.
 *
 * "Кремлев рассказал о планах федерации" is an ordinary news sentence, not a
 * second person. While the subject's surname was wrongly the given name, this
 * heuristic stayed silent by accident; with the surname correct it started
 * calling the subject's own materials someone else's. In an all-caps headline
 * the case says nothing, so no mark is set there either: "belonging needs
 * checking" is honester than a guess, and such a line is still not accepted as
 * the subject — the belonging model resolves it next.
 */
function looksLikeGivenNameToken(rawToken: string): boolean {
  const first = rawToken.charAt(0);
  if (first !== first.toLocaleUpperCase("ru-RU")) return false;
  return rawToken !== rawToken.toLocaleUpperCase("ru-RU");
}

/** Assesses how confidently a result refers to the audit subject. */
export function assessIdentityMatch(
  text: string,
  subject: SubjectIdentity | null
): IdentityConfidence {
  if (!subject?.fullName?.trim()) return "MEDIUM";
  if (isLikelyNamesake(text, subject)) return "LOW";

  const hay = normToken(text);
  const full = normToken(subject.fullName);
  if (full.length >= 5 && hay.includes(full)) return "HIGH";

  const hasSurname = containsToken(hay, subject.surname);
  const hasGiven = containsToken(hay, subject.givenName);
  const hasPat = subject.patronymic ? containsToken(hay, subject.patronymic) : false;

  if (hasSurname && hasGiven && hasPat) return "HIGH";
  if (hasSurname && hasGiven) return "MEDIUM";
  if (hasSurname || hasGiven) return "LOW";
  return "LOW";
}
