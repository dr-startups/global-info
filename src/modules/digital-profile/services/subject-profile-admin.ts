/**
 * Admin editing of the case-owned subject identity profile
 * (subject-identity-profile.json under the case-scoped artifact root).
 *
 * The profile is the single source the unified pipeline resolves at composite
 * time and the report rebuild refreshes into the job dir. Editable fields are
 * subject-supplied context only (contextIdentifiers, aliases, namesakes,
 * negative signals, INN); name identity comes from the case subject and the
 * generic builder — never hardcoded per subject.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ValidationError } from "../http/errors";
import type {
  SubjectIdentityProfile,
  SubjectNamesakeProfile,
} from "../orion-golden/identity/subject-identity-profile";
import { buildSubjectIdentityProfile } from "../orion-golden/identity/subject-identity-profile-builder";
import {
  isSelfConflictingNegativeSignal,
  ownNameTextOfVariants,
} from "../orion-golden/analytics/subject-resolution-classifier";
import {
  ORION_GOLDEN_QA_STORAGE_ROOT,
  caseScopedArtifactRoot,
} from "../orion-golden/evidence/admin-review-decision-store";

export const SUBJECT_PROFILE_FILENAME = "subject-identity-profile.json";

const MAX_LIST_ENTRIES = 100;
const MAX_ENTRY_LENGTH = 160;

export type SubjectProfileEdits = {
  /** Business-context words that strengthen a match (companies, sector, status). */
  contextIdentifiers?: string[];
  aliases?: string[];
  /** Other well-known people easily confused with the subject. */
  unrelatedKnownPersons?: string[];
  /** Patronymics of known homonyms (never the subject's own). */
  wrongPatronymics?: string[];
  namesakeProfiles?: SubjectNamesakeProfile[];
  inn?: string[];
};

export type SubjectProfileEditResult = {
  profile: SubjectIdentityProfile;
  /** Negative-signal entries dropped because they match the subject's own name. */
  droppedSelfConflicting: string[];
};

export function subjectProfilePath(caseId: string): string {
  return join(caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId), SUBJECT_PROFILE_FILENAME);
}

export function loadCaseSubjectIdentityProfile(caseId: string): SubjectIdentityProfile | null {
  const path = subjectProfilePath(caseId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SubjectIdentityProfile;
    return parsed.displayName ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeList(values: string[] | undefined, field: string): string[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new ValidationError(`${field} must be an array of strings`);
  if (values.length > MAX_LIST_ENTRIES) {
    throw new ValidationError(`${field}: too many entries (max ${MAX_LIST_ENTRIES})`);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== "string") throw new ValidationError(`${field} must contain only strings`);
    const v = raw.replace(/\s+/g, " ").trim();
    if (!v) continue;
    if (v.length > MAX_ENTRY_LENGTH) {
      throw new ValidationError(`${field}: entry too long (max ${MAX_ENTRY_LENGTH} chars)`);
    }
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

function normalizeNamesakes(
  values: SubjectNamesakeProfile[] | undefined
): SubjectNamesakeProfile[] {
  if (values === undefined) return [];
  if (!Array.isArray(values)) throw new ValidationError("namesakeProfiles must be an array");
  if (values.length > MAX_LIST_ENTRIES) {
    throw new ValidationError(`namesakeProfiles: too many entries (max ${MAX_LIST_ENTRIES})`);
  }
  return values
    .map((n) => ({
      label: String(n?.label ?? "").replace(/\s+/g, " ").trim(),
      noiseTerms: normalizeList(n?.noiseTerms ?? [], "namesakeProfiles.noiseTerms"),
    }))
    .filter((n) => n.label && n.noiseTerms.length > 0);
}

/**
 * Load the case profile or build the generic default from the case subject.
 * The default is deterministic and subject-agnostic (no hardcoded literals).
 */
export function getSubjectProfileForEdit(input: {
  caseId: string;
  subjectName: string;
  subjectAliases?: string[];
}): { profile: SubjectIdentityProfile; exists: boolean } {
  const existing = loadCaseSubjectIdentityProfile(input.caseId);
  if (existing) return { profile: existing, exists: true };
  const profile = buildSubjectIdentityProfile({
    caseId: input.caseId,
    subjectName: input.subjectName,
    aliases: input.subjectAliases ?? [],
  });
  return { profile, exists: false };
}

/**
 * Merge editable fields into the persisted profile (existing file or generic
 * default) and write it atomically to the case-scoped artifact root.
 * Negative signals matching the subject's own name are dropped fail-closed
 * and reported back so the operator sees what was rejected.
 */
export function saveSubjectProfileEdits(input: {
  caseId: string;
  subjectName: string;
  subjectAliases?: string[];
  edits: SubjectProfileEdits;
}): SubjectProfileEditResult {
  if (!input.subjectName?.trim()) throw new ValidationError("case subject name is required");

  const { profile: base } = getSubjectProfileForEdit(input);

  const contextIdentifiers = normalizeList(
    input.edits.contextIdentifiers ?? base.contextIdentifiers ?? [],
    "contextIdentifiers"
  );
  const aliases = normalizeList(input.edits.aliases ?? base.aliases ?? [], "aliases");
  const unrelatedRaw = normalizeList(
    input.edits.unrelatedKnownPersons ?? base.negativeIdentitySignals?.unrelatedKnownPersons ?? [],
    "unrelatedKnownPersons"
  );
  const wrongPatronymicsRaw = normalizeList(
    input.edits.wrongPatronymics ?? base.negativeIdentitySignals?.wrongPatronymics ?? [],
    "wrongPatronymics"
  );
  const namesakesRaw = normalizeNamesakes(
    input.edits.namesakeProfiles ?? base.namesakeProfiles ?? []
  );
  const inn = normalizeList(input.edits.inn ?? base.knownIdentifiers?.inn ?? [], "inn");
  for (const v of inn) {
    if (!/^\d{10}(\d{2})?$/.test(v)) {
      throw new ValidationError(`inn: "${v}" is not a valid 10/12-digit INN`);
    }
  }

  // Never persist negative signals that would fire on the subject's own name.
  const ownNameText = ownNameTextOfVariants([
    base.displayName,
    input.subjectName,
    ...aliases,
    ...(base.transliterations ?? []),
    ...(base.queryVariants ?? []),
    base.fullNameRu
      ? [base.fullNameRu.lastName, base.fullNameRu.firstName, base.fullNameRu.patronymic]
          .filter(Boolean)
          .join(" ")
      : "",
  ]);
  const droppedSelfConflicting: string[] = [];
  const keepNegative = (w: string): boolean => {
    if (isSelfConflictingNegativeSignal(ownNameText, w)) {
      droppedSelfConflicting.push(w);
      return false;
    }
    return true;
  };
  const unrelatedKnownPersons = unrelatedRaw.filter(keepNegative);
  const wrongPatronymics = wrongPatronymicsRaw.filter(keepNegative);
  const namesakeProfiles = namesakesRaw
    .map((n) => ({ label: n.label, noiseTerms: n.noiseTerms.filter(keepNegative) }))
    .filter((n) => n.noiseTerms.length > 0);

  const profile: SubjectIdentityProfile = {
    ...base,
    caseId: input.caseId,
    contextIdentifiers,
    aliases,
    namesakeProfiles,
    knownIdentifiers: {
      ...base.knownIdentifiers,
      inn: inn.length ? inn : undefined,
    },
    negativeIdentitySignals: {
      ...base.negativeIdentitySignals,
      wrongPatronymics,
      // Consistent with the builder: the same "other person" list feeds both.
      wrongNames: unrelatedKnownPersons,
      unrelatedKnownPersons,
      wrongBirthDates: base.negativeIdentitySignals?.wrongBirthDates ?? [],
    },
  };

  const path = subjectProfilePath(input.caseId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

  return { profile, droppedSelfConflicting };
}
