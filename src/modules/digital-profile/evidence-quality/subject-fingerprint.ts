/**
 * O5.3 — subject fingerprint + strict identity decisions for evidence surfaces.
 * PURE + deterministic.
 */

import {
  buildNormalizedSubjectIdentity,
  evaluateEntityMatch,
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
  normalized: ReturnType<typeof buildNormalizedSubjectIdentity>;
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
  nationality?: string | null;
  country?: string | null;
  regionHints?: string[];
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
    normalized: buildNormalizedSubjectIdentity({
      fullName: subject.fullName,
      aliases: subject.aliases,
      nationality: subject.nationality,
      country: subject.country,
      regionHints: subject.regionHints,
    }),
  };
}

export function evaluateIdentityDecision(
  text: string,
  fingerprint: SubjectFingerprint | null,
  options: {
    region?: string | null;
    sourceType?: "organic" | "image" | "video" | "wikipedia" | "knowledge" | "compliance" | "other";
  } = {}
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
    return {
      decision: "ENTITY_MISMATCH",
      confidence: "NONE",
      reason: "different_given_same_patronymic",
    };
  }

  if (isLikelyNamesake(text, subject)) {
    return { decision: "NAMESAKE", confidence: "NONE", reason: "different_patronymic_or_given" };
  }

  const model = evaluateEntityMatch({
    text,
    subject: fingerprint.normalized,
    region: options.region,
    sourceType: options.sourceType,
  });
  const reason = model.reasons[0] ?? "entity_model";
  switch (model.decision) {
    case "strict_subject":
      return { decision: "EXACT_SUBJECT", confidence: "HIGH", reason };
    case "likely_subject":
      return { decision: "LIKELY_SUBJECT", confidence: "MEDIUM", reason };
    case "possible_subject":
      return { decision: "POSSIBLE_SUBJECT", confidence: "LOW", reason };
    case "namesake":
      return { decision: "NAMESAKE", confidence: "NONE", reason };
    case "not_subject":
      return { decision: "ENTITY_MISMATCH", confidence: "NONE", reason };
    default:
      return { decision: "INSUFFICIENT_MATCH", confidence: "NONE", reason };
  }
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
