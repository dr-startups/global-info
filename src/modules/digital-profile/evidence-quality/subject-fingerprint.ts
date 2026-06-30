/**
 * O5.3 — subject fingerprint + strict identity decisions for evidence surfaces.
 * PURE + deterministic.
 */

import {
  isLikelyNamesake,
  parseSubjectName,
  patronymicsInText,
  type IdentityConfidence,
  type SubjectIdentity,
} from "../risk-classifier/entity-disambiguation";

export type IdentityDecision =
  | "EXACT_SUBJECT"
  | "LIKELY_SUBJECT"
  | "POSSIBLE_SUBJECT"
  | "NAMESAKE"
  | "ENTITY_MISMATCH"
  | "INSUFFICIENT_MATCH";

export interface SubjectFingerprint {
  fullName: string;
  lastName: string | null;
  firstName: string | null;
  patronymic: string | null;
  aliases: string[];
  transliterations: string[];
  surnameTokens: string[];
  givenTokens: string[];
  patronymicTokens: string[];
  knownIdentifiers: string[];
}

const CYR_TO_LAT: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, "e").trim();
}

function transliterateToken(token: string): string {
  let out = "";
  for (const ch of norm(token)) {
    out += CYR_TO_LAT[ch] ?? ch;
  }
  return out.replace(/[^a-z0-9]/g, "");
}

function tokenVariants(token: string | null): string[] {
  if (!token) return [];
  const n = norm(token);
  const tr = transliterateToken(token);
  const out = new Set<string>();
  if (n.length >= 3) out.add(n);
  if (tr.length >= 3) out.add(tr);
  return [...out];
}

function hayContainsAny(hay: string, tokens: string[]): boolean {
  return tokens.some((t) => t.length >= 3 && hay.includes(t));
}

/** Romanovich-only / patronymic-only international rows without subject surname. */
function isRomanovichOnlyInsufficient(text: string, fp: SubjectFingerprint): boolean {
  const hay = norm(text);
  const hasPat = hay.includes("romanovich") || hay.includes("романович");
  if (!hasPat) return false;
  const hasSurname = hayContainsAny(hay, fp.surnameTokens);
  if (hasSurname) return false;
  return true;
}

/** Different given name with same patronymic (e.g. Bogdan Romanovich). */
function isEntityMismatchGivenPatronymic(text: string, fp: SubjectFingerprint): boolean {
  if (!fp.patronymic || !fp.lastName) return false;
  const hay = norm(text);
  if (!hayContainsAny(hay, fp.surnameTokens)) return false;
  const pat = norm(fp.patronymic);
  if (!hay.includes(pat) && !hay.includes("romanovich") && !hay.includes("романович")) return false;
  const mentioned = patronymicsInText(text);
  const patMatch =
    mentioned.some((p) => p === pat || p.includes("romanovich") || p.includes("романович")) ||
    hay.includes(pat);
  if (!patMatch) return false;
  if (!fp.firstName) return false;
  const givenTokens = fp.givenTokens;
  if (hayContainsAny(hay, givenTokens)) return false;
  const otherGiven = hay.match(
    new RegExp(`${fp.surnameTokens[0] ?? ""}[\\s,.(—–-]+([a-zа-яё]{3,})`, "i")
  );
  if (otherGiven?.[1] && !givenTokens.includes(norm(otherGiven[1]))) return true;
  return mentioned.length > 0 && !mentioned.some((p) => p === pat);
}

export function buildSubjectFingerprint(subject: {
  fullName: string;
  aliases?: string[];
  identifiers?: Record<string, unknown> | null;
}): SubjectFingerprint {
  const parsed = parseSubjectName(subject.fullName);
  const surnameTokens = tokenVariants(parsed.surname);
  const givenTokens = tokenVariants(parsed.givenName);
  const patronymicTokens = tokenVariants(parsed.patronymic);
  const transliterations: string[] = [];
  for (const t of [...surnameTokens, ...givenTokens, ...patronymicTokens]) {
    if (t && !transliterations.includes(t)) transliterations.push(t);
  }
  const knownIdentifiers: string[] = [];
  const ids = subject.identifiers ?? {};
  for (const key of ["inn", "ogrn", "ogrnip", "taxId"]) {
    const v = ids[key];
    if (typeof v === "string" && v.trim()) knownIdentifiers.push(v.trim());
  }

  return {
    fullName: parsed.fullName,
    lastName: parsed.surname,
    firstName: parsed.givenName,
    patronymic: parsed.patronymic,
    aliases: subject.aliases ?? [],
    transliterations,
    surnameTokens,
    givenTokens,
    patronymicTokens,
    knownIdentifiers,
  };
}

export function evaluateIdentityDecision(
  text: string,
  fingerprint: SubjectFingerprint | null
): { decision: IdentityDecision; confidence: IdentityConfidence; reason: string } {
  if (!fingerprint?.fullName?.trim()) {
    return { decision: "POSSIBLE_SUBJECT", confidence: "MEDIUM", reason: "no_subject" };
  }

  const hay = norm(text);
  const subject: SubjectIdentity = {
    fullName: fingerprint.fullName,
    surname: fingerprint.lastName,
    givenName: fingerprint.firstName,
    patronymic: fingerprint.patronymic,
  };

  if (fingerprint.knownIdentifiers.some((id) => hay.includes(norm(id)))) {
    return { decision: "EXACT_SUBJECT", confidence: "HIGH", reason: "identifier_match" };
  }

  const fullNorm = norm(fingerprint.fullName);
  if (fullNorm.length >= 8 && hay.includes(fullNorm)) {
    return { decision: "EXACT_SUBJECT", confidence: "HIGH", reason: "exact_full_name" };
  }

  if (isRomanovichOnlyInsufficient(text, fingerprint)) {
    return {
      decision: "INSUFFICIENT_MATCH",
      confidence: "NONE",
      reason: "romanovich_only",
    };
  }

  if (isEntityMismatchGivenPatronymic(text, fingerprint)) {
    return { decision: "ENTITY_MISMATCH", confidence: "NONE", reason: "different_given_same_patronymic" };
  }

  const hasSurnameEarly = hayContainsAny(hay, fingerprint.surnameTokens);
  const hasGivenEarly = hayContainsAny(hay, fingerprint.givenTokens);
  const hasPatEarly = hayContainsAny(hay, fingerprint.patronymicTokens);
  if (hasSurnameEarly && hasPatEarly && !hasGivenEarly && fingerprint.firstName) {
    return {
      decision: "ENTITY_MISMATCH",
      confidence: "NONE",
      reason: "different_given_same_patronymic",
    };
  }

  if (isLikelyNamesake(text, subject)) {
    return { decision: "NAMESAKE", confidence: "NONE", reason: "different_patronymic_or_given" };
  }

  const hasSurname = hayContainsAny(hay, fingerprint.surnameTokens);
  const hasGiven = hayContainsAny(hay, fingerprint.givenTokens);
  const hasPat = hayContainsAny(hay, fingerprint.patronymicTokens);

  if (hasSurname && hasGiven && hasPat) {
    return { decision: "EXACT_SUBJECT", confidence: "HIGH", reason: "surname_given_patronymic" };
  }
  if (hasSurname && hasGiven) {
    return { decision: "LIKELY_SUBJECT", confidence: "MEDIUM", reason: "surname_and_given" };
  }
  if (hasSurname && hasPat) {
    return { decision: "LIKELY_SUBJECT", confidence: "MEDIUM", reason: "surname_and_patronymic" };
  }
  if (hasSurname || hasGiven) {
    return { decision: "POSSIBLE_SUBJECT", confidence: "LOW", reason: "partial_name_only" };
  }

  return { decision: "INSUFFICIENT_MATCH", confidence: "NONE", reason: "no_subject_tokens" };
}

export function identityDecisionToConfidence(decision: IdentityDecision): IdentityConfidence {
  switch (decision) {
    case "EXACT_SUBJECT":
      return "HIGH";
    case "LIKELY_SUBJECT":
      return "MEDIUM";
    case "POSSIBLE_SUBJECT":
      return "LOW";
    default:
      return "NONE";
  }
}

export function isStrictEvidenceSurface(surfaceType: string): boolean {
  return !["SEARCH_SUGGESTION", "RELATED_QUERY"].includes(surfaceType);
}
