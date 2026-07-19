/**
 * Prompt 2 — subject resolution classifier.
 * Classifies every composite observation as SUBJECT_MATCH / LIKELY_SUBJECT /
 * AMBIGUOUS / OTHER_SUBJECT / INSUFFICIENT_IDENTIFIERS.
 *
 * Surname-only never becomes SUBJECT_MATCH. Surname + context (or shared
 * confirmed domain / soft-surface full-name phrase) may become LIKELY_SUBJECT
 * (confidence 0.6–0.7) — visible in SERP/appendix/matrix «Требует подтверждения»
 * but never in KPI «О субъекте». Only SUBJECT_MATCH may affect KPI.
 */

import { createHash } from "node:crypto";
import type { RawInventoryItem } from "../types";
import {
  SUBJECT_RESOLUTION_SCHEMA_VERSION,
  SubjectResolutionSchema,
  type SubjectResolution,
  type SubjectResolutionItem,
} from "../contracts/subject-resolution";
import type { SubjectRelevanceDecision } from "../contracts/common";

/** A specific homonym/namesake of the subject and its disambiguating noise. */
export type NamesakeProfile = {
  /** Client-facing label for the OTHER person, e.g. "Иван Петров (актёр)". */
  label: string;
  /** Lowercased tokens whose presence indicates this OTHER subject. */
  noiseTerms: string[];
};

export type SubjectIdentity = {
  displayName: string;
  lastName: string;
  /** Surname variants incl. transliterations (subject-supplied, not hardcoded). */
  lastNameVariants: string[];
  firstNames: string[]; // ru + translit
  patronymics: string[];
  aliases: string[];
  strongIdentifiers: string[]; // e.g. INN
  contextIdentifiers: string[]; // business context words strengthening a match
  wrongFirstNames: string[];
  wrongPatronymics: string[];
  unrelatedKnownPersons: string[];
  /** Namesake noise (per homonym) — entirely subject-supplied, never hardcoded. */
  namesakeProfiles: NamesakeProfile[];
  /** Flattened noise terms across all namesakes (convenience for matching). */
  namesakeNoise: string[];
};

function norm(text: string): string {
  return text.toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

function itemText(item: RawInventoryItem): string {
  // item.query is what WE searched for, not what the content says —
  // including it would turn every result of a subject query into a match.
  // Exception: query-является-контентом surfaces (suggestions/PAA) store the
  // line in title, so title/snippet/sourceUrl are sufficient.
  return norm([item.title, item.snippet, item.sourceUrl].filter(Boolean).join(" "));
}

function surfaceOf(item: RawInventoryItem): string {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  return String(meta.surface ?? item.evidenceType ?? "").toLowerCase();
}

/** Soft SERP lines where a full-name phrase is suggestive, not confirmatory. */
function isSuggestionOrPaaSurface(surface: string): boolean {
  return /suggest|paa|people_also|related/.test(surface);
}

function domainOfUrl(url: string | undefined | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Display-name or first+last phrase present in text (upgrade path for soft surfaces). */
function hasFullNamePhrase(text: string, subject: SubjectIdentity): boolean {
  const display = norm(subject.displayName);
  if (display.length >= 6 && text.includes(display)) return true;
  const first = subject.firstNames.find((n) => matchesToken(text, n));
  const last =
    matchesToken(text, subject.lastName) ||
    subject.lastNameVariants.some((v) => matchesToken(text, v));
  return Boolean(first && last);
}

/**
 * Morphology-tolerant token match: Russian case endings inflect the last
 * letter(s), so for tokens >=5 chars also try the stem without the final
 * letter (e.g. a given name "иван" → matches "Ивана"/"Ивану"; a surname
 * "петров" → "петро" matches inflected forms).
 */
function matchesToken(text: string, name: string): boolean {
  const n = norm(name);
  if (n.length < 3) return false;
  if (text.includes(n)) return true;
  if (n.length >= 5 && text.includes(n.slice(0, -1))) return true;
  return false;
}

/**
 * True when a negative identity signal would fire on the subject's OWN name
 * text (same substring/stem matching the classifier uses). Such an entry is
 * self-conflicting: it marks every genuine mention of the subject as a
 * namesake conflict. Negative signals must describe OTHER people only
 * (e.g. a homonym's distinct patronymic), never the subject's own name,
 * transliteration or alias.
 */
export function isSelfConflictingNegativeSignal(
  ownNameText: string,
  entry: string
): boolean {
  const n = norm(entry);
  if (n.length < 3) return false;
  return matchesToken(ownNameText, entry) || ownNameText.includes(n);
}

/** Normalized own-name haystack (one variant per line) for self-conflict checks. */
export function ownNameTextOfVariants(variants: Array<string | undefined | null>): string {
  return variants
    .filter((v): v is string => Boolean(v && v.trim()))
    .map(norm)
    .join("\n");
}

export function classifySubjectRelevance(
  item: RawInventoryItem,
  subject: SubjectIdentity
): SubjectResolutionItem {
  const text = itemText(item);
  const evidenceRef = `inventory:${item.inventoryId}`;
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;

  // Compliance hits: decision comes from DatabaseProfile.reviewStatus.
  // Surname/token F1 must not reclassify LexisNexis / Dow Jones rows.
  if (meta.skipTextClassifier === true || meta.identityFromReview === true) {
    const reviewStatus = String(meta.reviewStatus ?? item.classification ?? "").toUpperCase();
    const confirmed = reviewStatus === "MATCH_CONFIRMED" || reviewStatus === "CONFIRMED";
    return {
      evidenceRef,
      decision: confirmed ? "SUBJECT_MATCH" : "AMBIGUOUS",
      confidence: confirmed ? 0.95 : 0.55,
      matchedIdentifiers: confirmed ? ["compliance_review_confirmed"] : [],
      conflictingIdentifiers: [],
      reasonCode: confirmed ? "compliance_match_confirmed" : "compliance_review_pending",
    };
  }

  const hasSurname =
    [subject.lastName, ...subject.lastNameVariants].some((s) => matchesToken(text, s)) ||
    subject.aliases.some((a) => norm(a).length > 4 && text.includes(norm(a)));

  const matchedIdentifiers: string[] = [];
  const conflictingIdentifiers: string[] = [];

  if (hasSurname) matchedIdentifiers.push(subject.lastName);

  const matchedFirstName = subject.firstNames.find((n) => matchesToken(text, n));
  if (matchedFirstName) matchedIdentifiers.push(matchedFirstName);

  const matchedPatronymic = subject.patronymics.find(
    (p) => norm(p).length > 3 && matchesToken(text, p)
  );
  if (matchedPatronymic) matchedIdentifiers.push(matchedPatronymic);

  const matchedStrong = subject.strongIdentifiers.find(
    (s) => s.length > 4 && text.includes(norm(s))
  );
  if (matchedStrong) matchedIdentifiers.push(matchedStrong);

  const matchedContext = subject.contextIdentifiers.filter(
    (c) => norm(c).length > 3 && text.includes(norm(c))
  );
  matchedIdentifiers.push(...matchedContext);

  for (const w of [...subject.wrongFirstNames, ...subject.unrelatedKnownPersons]) {
    if (norm(w).length > 3 && matchesToken(text, w)) conflictingIdentifiers.push(w);
  }
  for (const w of subject.wrongPatronymics) {
    if (norm(w).length > 3 && matchesToken(text, w)) conflictingIdentifiers.push(w);
  }
  for (const n of subject.namesakeNoise) {
    if (n.length > 2 && text.includes(norm(n))) conflictingIdentifiers.push(n);
  }

  let decision: SubjectRelevanceDecision;
  let reasonCode: string;
  let confidence: number;

  const hasGivenName = Boolean(matchedFirstName || matchedPatronymic || matchedStrong);
  const hasConflict = conflictingIdentifiers.length > 0;

  if (!hasSurname && !hasGivenName) {
    if (hasConflict) {
      decision = "OTHER_SUBJECT";
      reasonCode = "conflicting_identity_no_subject_tokens";
      confidence = 0.9;
    } else {
      decision = "INSUFFICIENT_IDENTIFIERS";
      reasonCode = "no_subject_tokens";
      confidence = 0.85;
    }
  } else if (hasConflict && !hasGivenName) {
    // Surname + composer/wrong-person context → other subject.
    decision = "OTHER_SUBJECT";
    reasonCode = "namesake_conflict";
    confidence = 0.9;
  } else if (hasConflict && hasGivenName) {
    // Both subject identifiers and conflicting identity — ambiguous, review.
    decision = "AMBIGUOUS";
    reasonCode = "mixed_identity_signals";
    confidence = 0.5;
  } else if (hasSurname && hasGivenName) {
    decision = "SUBJECT_MATCH";
    reasonCode = matchedStrong
      ? "strong_identifier_match"
      : matchedContext.length > 0
        ? "full_name_with_context"
        : "full_name_match";
    confidence = matchedStrong ? 0.98 : matchedContext.length > 0 ? 0.92 : 0.85;
  } else if (hasSurname && !hasGivenName) {
    // Surname without given name: never SUBJECT_MATCH. Strong context or a
    // soft-surface full-name phrase → LIKELY_SUBJECT; otherwise AMBIGUOUS.
    if (matchedContext.length > 0) {
      decision = "LIKELY_SUBJECT";
      reasonCode = "surname_with_context";
      confidence = 0.65;
    } else if (
      isSuggestionOrPaaSurface(surfaceOf(item)) &&
      hasFullNamePhrase(text, subject)
    ) {
      decision = "LIKELY_SUBJECT";
      reasonCode = /paa|people_also|related/.test(surfaceOf(item))
        ? "paa_full_name"
        : "suggestion_full_name";
      confidence = 0.68;
    } else {
      decision = "AMBIGUOUS";
      reasonCode = "surname_only";
      confidence = 0.4;
    }
  } else {
    // Given name without surname (rare) — insufficient.
    decision = "INSUFFICIENT_IDENTIFIERS";
    reasonCode = "partial_name_without_surname";
    confidence = 0.5;
  }

  return {
    evidenceRef,
    decision,
    confidence,
    matchedIdentifiers: [...new Set(matchedIdentifiers)],
    conflictingIdentifiers: [...new Set(conflictingIdentifiers)],
    reasonCode,
  };
}

/**
 * Pass after text classification: surname_only AMBIGUOUS on a domain that
 * already hosts conflict-free SUBJECT_MATCH evidence → LIKELY_SUBJECT.
 * Never promotes to SUBJECT_MATCH; conflicts stay untouched.
 */
export function promoteLikelyBySharedDomain(input: {
  items: RawInventoryItem[];
  resolution: SubjectResolution;
}): SubjectResolution {
  const byRef = new Map(input.resolution.items.map((r) => [r.evidenceRef, r]));
  const matchDomains = new Set<string>();
  for (const item of input.items) {
    const ref = `inventory:${item.inventoryId}`;
    const r = byRef.get(ref);
    if (r?.decision !== "SUBJECT_MATCH" || r.conflictingIdentifiers.length > 0) continue;
    const domain = domainOfUrl(item.sourceUrl);
    if (domain) matchDomains.add(domain);
  }
  if (matchDomains.size === 0) return input.resolution;

  const items = input.resolution.items.map((r) => {
    if (r.decision !== "AMBIGUOUS" || r.reasonCode !== "surname_only") return r;
    if (r.conflictingIdentifiers.length > 0) return r;
    const item = input.items.find((i) => `inventory:${i.inventoryId}` === r.evidenceRef);
    const domain = domainOfUrl(item?.sourceUrl);
    if (!domain || !matchDomains.has(domain)) return r;
    return {
      ...r,
      decision: "LIKELY_SUBJECT" as const,
      reasonCode: "surname_with_confirmed_domain",
      confidence: 0.62,
    };
  });

  return SubjectResolutionSchema.parse({
    ...input.resolution,
    schemaVersion: SUBJECT_RESOLUTION_SCHEMA_VERSION,
    items,
    evidenceRefs: items.map((i) => i.evidenceRef),
  });
}

export function buildSubjectResolution(input: {
  caseId: string;
  datasetId: string;
  subject: SubjectIdentity;
  items: RawInventoryItem[];
  sourceHashes: string[];
}): SubjectResolution {
  const classified = input.items.map((i) => classifySubjectRelevance(i, input.subject));
  const base = SubjectResolutionSchema.parse({
    schemaVersion: SUBJECT_RESOLUTION_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: classified.map((i) => i.evidenceRef),
    subjectDisplayName: input.subject.displayName,
    items: classified,
  });
  return promoteLikelyBySharedDomain({ items: input.items, resolution: base });
}

/** Profile shape consumed by the classifier (subset of SubjectIdentityProfile). */
export type ClassifierSubjectProfile = {
  displayName: string;
  /**
   * Positional Russian name. LOWER-CONFIDENCE backward-compat fallback ONLY:
   * used when the structured fields below are absent. It must not be assumed to
   * exist and does not imply a patronymic or Russian name order.
   */
  fullNameRu?: { lastName?: string; firstName?: string; patronymic?: string };
  /** Structured dynamic identity (preferred; subject-supplied). */
  givenNames?: string[];
  familyNames?: string[];
  patronymics?: string[];
  aliases?: string[];
  transliterations?: string[];
  contextIdentifiers?: string[];
  namesakeProfiles?: NamesakeProfile[];
  knownIdentifiers?: { inn?: string[] };
  negativeIdentitySignals?: {
    wrongPatronymics?: string[];
    wrongNames?: string[];
    unrelatedKnownPersons?: string[];
  };
};

/**
 * Adapter from a subject profile to the matcher's SubjectIdentity.
 *
 * Every subject-specific value comes from the profile — there are NO hardcoded
 * names, patronymics, business terms or namesake noise here. Structured fields
 * (givenNames/familyNames/patronymics/…) are preferred; positional `fullNameRu`
 * is only a lower-confidence fallback and never assumes Russian ordering or the
 * existence of a patronymic.
 */
export function subjectIdentityFromProfile(profile: ClassifierSubjectProfile): SubjectIdentity {
  const structuredFamily = (profile.familyNames ?? []).filter(Boolean);
  const structuredGiven = (profile.givenNames ?? []).filter(Boolean);
  const structuredPatr = (profile.patronymics ?? []).filter(Boolean);

  // Surname transliteration token. Prefer the token that corresponds to a known
  // family name (structured or positional); only fall back to the "shared by all
  // variants" heuristic when family names are unknown. This avoids mislabelling
  // the given-name token as the surname for non-Russian, given-first names.
  const familyTokenSet = new Set(
    [...structuredFamily, profile.fullNameRu?.lastName ?? ""]
      .flatMap((f) => f.toLowerCase().replace(/ё/gu, "е").split(/\s+/))
      .filter((w) => w.length > 2)
  );
  const translits = (profile.transliterations ?? []).map((t) => t.toLowerCase());
  const tokenSets = translits.map((t) => new Set(t.split(/\s+/).filter((w) => w.length > 2)));
  const sharedTokens =
    tokenSets.length > 0
      ? [...tokenSets[0]].filter((tok) => tokenSets.every((s) => s.has(tok)))
      : [];
  const matchesFamily = (tok: string): boolean =>
    familyTokenSet.has(tok) ||
    [...familyTokenSet].some(
      (ft) => (ft.length >= 4 && tok.startsWith(ft.slice(0, 4))) || (tok.length >= 4 && ft.startsWith(tok.slice(0, 4)))
    );
  const surnameTranslit = sharedTokens.find(matchesFamily) ?? sharedTokens[0] ?? "";
  // Non-surname translit tokens become first-name candidates — but never tokens
  // that transliterate a known family name (guards the surname leaking in as a
  // first name for given-first Latin names).
  const translitFirsts = translits.flatMap((t) =>
    t.split(/\s+/).filter((w) => w.length > 2 && w !== surnameTranslit && !matchesFamily(w))
  );

  // Backward-compat positional fallback (lower confidence): only used to seed
  // fields the structured profile did not provide.
  const positionalLast = profile.fullNameRu?.lastName ?? "";
  const positionalFirst = profile.fullNameRu?.firstName ?? "";
  const positionalPatr = profile.fullNameRu?.patronymic ?? "";

  const lastName =
    structuredFamily[0] ?? positionalLast ?? profile.displayName.split(/\s+/)[0] ?? "";
  const lastNameVariants = [
    ...new Set([...structuredFamily.slice(1), surnameTranslit].filter(Boolean)),
  ];
  const firstNames = [
    ...new Set([...structuredGiven, positionalFirst, ...translitFirsts].filter(Boolean)),
  ];
  const patronymics = [...new Set([...structuredPatr, positionalPatr].filter(Boolean))];

  // Guard against misconfigured profiles that list the subject's own name /
  // transliteration / alias among negative signals: dropping them here keeps
  // genuine subject mentions from being classified as namesake conflicts.
  const ownNameText = ownNameTextOfVariants([
    profile.displayName,
    lastName,
    ...lastNameVariants,
    ...firstNames,
    ...patronymics,
    ...(profile.aliases ?? []),
    ...(profile.transliterations ?? []),
    profile.fullNameRu
      ? [profile.fullNameRu.lastName, profile.fullNameRu.firstName, profile.fullNameRu.patronymic]
          .filter(Boolean)
          .join(" ")
      : "",
  ]);
  const notSelfConflicting = (w: string): boolean =>
    !isSelfConflictingNegativeSignal(ownNameText, w);

  const namesakeProfiles = (profile.namesakeProfiles ?? []).map((n) => ({
    label: n.label,
    noiseTerms: n.noiseTerms.map((t) => t.toLowerCase()).filter(notSelfConflicting),
  }));
  const namesakeNoise = [...new Set(namesakeProfiles.flatMap((n) => n.noiseTerms))];

  return {
    displayName: profile.displayName,
    lastName,
    lastNameVariants,
    firstNames,
    patronymics,
    aliases: [...new Set([...(profile.aliases ?? []), ...(profile.transliterations ?? [])])],
    strongIdentifiers: profile.knownIdentifiers?.inn ?? [],
    contextIdentifiers: [...new Set(profile.contextIdentifiers ?? [])],
    wrongFirstNames: (profile.negativeIdentitySignals?.wrongNames ?? []).filter(notSelfConflicting),
    wrongPatronymics: (profile.negativeIdentitySignals?.wrongPatronymics ?? []).filter(
      notSelfConflicting
    ),
    unrelatedKnownPersons: (profile.negativeIdentitySignals?.unrelatedKnownPersons ?? []).filter(
      notSelfConflicting
    ),
    namesakeProfiles,
    namesakeNoise,
  };
}

export function subjectResolutionDigest(resolution: SubjectResolution): string {
  return createHash("sha256")
    .update(JSON.stringify(resolution.items.map((i) => `${i.evidenceRef}:${i.decision}`)))
    .digest("hex")
    .slice(0, 16);
}
