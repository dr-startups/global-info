/**
 * Prompt 2 — subject resolution classifier.
 * Classifies every composite observation as SUBJECT_MATCH / AMBIGUOUS /
 * OTHER_SUBJECT / INSUFFICIENT_IDENTIFIERS.
 * Surname-only matches never become SUBJECT_MATCH; only SUBJECT_MATCH may
 * affect KPI. Ambiguous evidence is retained for review/appendix.
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

export type SubjectIdentity = {
  displayName: string;
  lastName: string;
  /** Surname variants incl. transliterations (e.g. "глинка", "glinka"). */
  lastNameVariants: string[];
  firstNames: string[]; // ru + translit
  patronymics: string[];
  aliases: string[];
  strongIdentifiers: string[]; // e.g. INN
  contextIdentifiers: string[]; // business context words strengthening a match
  wrongFirstNames: string[];
  wrongPatronymics: string[];
  unrelatedKnownPersons: string[];
};

/** Known namesake noise for the composer namesake class (extends profile signals). */
const COMPOSER_NOISE = [
  "михаил глинка",
  "михаила глинки",
  "mikhail glinka",
  "композитор",
  "composer",
  "опера",
  "opera",
  "жизнь за царя",
  "руслан и людмила",
  "imslp",
  "симфони",
  "романс",
  "партитур",
];

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

/**
 * Morphology-tolerant token match: Russian case endings inflect the last
 * letter(s), so for tokens >=5 chars also try the stem without the final
 * letter ("сергей" → "серге" matches "Сергея"/"Сергею"; "глинка" → "глинк").
 */
function matchesToken(text: string, name: string): boolean {
  const n = norm(name);
  if (n.length < 3) return false;
  if (text.includes(n)) return true;
  if (n.length >= 5 && text.includes(n.slice(0, -1))) return true;
  return false;
}

export function classifySubjectRelevance(
  item: RawInventoryItem,
  subject: SubjectIdentity
): SubjectResolutionItem {
  const text = itemText(item);
  const evidenceRef = `inventory:${item.inventoryId}`;

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
  for (const n of COMPOSER_NOISE) {
    if (text.includes(n)) conflictingIdentifiers.push(n);
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
    // Surname-only: NEVER SUBJECT_MATCH.
    decision = "AMBIGUOUS";
    reasonCode = "surname_only";
    confidence = 0.4;
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

export function buildSubjectResolution(input: {
  caseId: string;
  datasetId: string;
  subject: SubjectIdentity;
  items: RawInventoryItem[];
  sourceHashes: string[];
}): SubjectResolution {
  const items = input.items.map((i) => classifySubjectRelevance(i, input.subject));
  return SubjectResolutionSchema.parse({
    schemaVersion: SUBJECT_RESOLUTION_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: items.map((i) => i.evidenceRef),
    subjectDisplayName: input.subject.displayName,
    items,
  });
}

/** Adapter from the production subject-identity-profile.json shape. */
export function subjectIdentityFromProfile(profile: {
  displayName: string;
  fullNameRu?: { lastName?: string; firstName?: string; patronymic?: string };
  aliases?: string[];
  transliterations?: string[];
  knownIdentifiers?: { inn?: string[] };
  negativeIdentitySignals?: {
    wrongPatronymics?: string[];
    wrongNames?: string[];
    unrelatedKnownPersons?: string[];
  };
}): SubjectIdentity {
  const first = profile.fullNameRu?.firstName ?? "";
  // Surname transliteration: the token shared by every transliteration variant.
  const translits = (profile.transliterations ?? []).map((t) => t.toLowerCase());
  const tokenSets = translits.map((t) => new Set(t.split(/\s+/).filter((w) => w.length > 2)));
  const surnameTranslit =
    tokenSets.length > 0
      ? [...tokenSets[0]].find((tok) => tokenSets.every((s) => s.has(tok))) ?? ""
      : "";
  const translitFirsts = translits
    .map((t) => t.split(/\s+/).find((w) => w.length > 2 && w !== surnameTranslit) ?? "")
    .filter(Boolean);
  return {
    displayName: profile.displayName,
    lastName: profile.fullNameRu?.lastName ?? profile.displayName.split(/\s+/)[0] ?? "",
    lastNameVariants: surnameTranslit ? [surnameTranslit] : [],
    firstNames: [...new Set([first, "sergey", "sergei", ...translitFirsts].filter(Boolean))],
    patronymics: [profile.fullNameRu?.patronymic ?? "", "mikhaylovich", "mikhailovich"].filter(
      Boolean
    ),
    aliases: [...new Set([...(profile.aliases ?? []), ...(profile.transliterations ?? [])])],
    strongIdentifiers: profile.knownIdentifiers?.inn ?? [],
    contextIdentifiers: ["бизнесмен", "businessman", "предприниматель", "инвестор", "транспорт", "логистик"],
    wrongFirstNames: profile.negativeIdentitySignals?.wrongNames ?? [],
    wrongPatronymics: profile.negativeIdentitySignals?.wrongPatronymics ?? [],
    unrelatedKnownPersons: profile.negativeIdentitySignals?.unrelatedKnownPersons ?? [],
  };
}

export function subjectResolutionDigest(resolution: SubjectResolution): string {
  return createHash("sha256")
    .update(JSON.stringify(resolution.items.map((i) => `${i.evidenceRef}:${i.decision}`)))
    .digest("hex")
    .slice(0, 16);
}
