/**
 * R10.7b — Homonym / patronymic disambiguation policy.
 */

import type { SubjectIdentityProfile } from "./subject-identity-profile";

export type HomonymAssessment = {
  hasPatronymicMismatch: boolean;
  mismatchedPatronymics: string[];
  hasSurnameOnlyMatch: boolean;
  hasMultiPersonSnippet: boolean;
  titleAboutOtherPerson: boolean;
  famousUnrelatedPerson: boolean;
  signals: string[];
};

function lower(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Assess homonym / patronymic conflict signals in evidence text.
 * Does not alone decide binding — used by the scorer.
 */
export function assessHomonymSignals(
  text: string,
  profile: SubjectIdentityProfile
): HomonymAssessment {
  const low = lower(text);
  const full = profile.fullNameRu;
  const signals: string[] = [];
  const mismatchedPatronymics: string[] = [];

  let hasPatronymicMismatch = false;
  let hasSurnameOnlyMatch = false;
  let hasMultiPersonSnippet = false;
  let titleAboutOtherPerson = false;
  let famousUnrelatedPerson = false;

  for (const wrong of profile.negativeIdentitySignals.unrelatedKnownPersons) {
    if (low.includes(lower(wrong))) {
      famousUnrelatedPerson = true;
      signals.push(`unrelated_known_person:${wrong}`);
    }
  }

  if (full?.lastName && full.firstName && full.patronymic) {
    const last = lower(full.lastName);
    const first = lower(full.firstName);
    const ownPat = lower(full.patronymic);

    const re = new RegExp(
      `${escapeRe(last)}\\s+${escapeRe(first)}\\s+([а-яё-]{4,20}(?:ович|евич|ич|овна|евна|ична))`,
      "gi"
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(low)) !== null) {
      const pat = lower(m[1] ?? "");
      if (pat && pat !== ownPat) {
        hasPatronymicMismatch = true;
        mismatchedPatronymics.push(m[1]!);
        signals.push(`patronymic_mismatch:${m[1]}`);
      }
    }

    // Known wrong patronymics only when contiguous "Last First WrongPat" appears
    for (const wp of profile.negativeIdentitySignals.wrongPatronymics) {
      const w = lower(wp);
      if (w === ownPat) continue;
      const contig = new RegExp(
        `${escapeRe(last)}\\s+${escapeRe(first)}\\s+${escapeRe(w)}`,
        "i"
      );
      if (contig.test(low)) {
        hasPatronymicMismatch = true;
        mismatchedPatronymics.push(wp);
        signals.push(`known_wrong_patronymic:${wp}`);
      }
    }

    // Surname-only (no first name / no INN context)
    if (low.includes(last) && !low.includes(first) && !/\bинн\b|\b\d{10,12}\b/.test(low)) {
      hasSurnameOnlyMatch = true;
      signals.push("surname_only_match");
    }
  }

  // Multiple distinct FIO-like patterns → multi-person snippet
  const fioHits = low.match(/[а-яё-]{3,}\s+[а-яё-]{3,}(?:\s+[а-яё-]{3,})?/g) ?? [];
  if (fioHits.length >= 4) {
    hasMultiPersonSnippet = true;
    signals.push("multi_person_snippet");
  }

  // Title-like lead mentions another person with different patronymic while subject absent
  if (full?.patronymic && full.lastName && full.firstName) {
    const ownFull = lower(`${full.lastName} ${full.firstName} ${full.patronymic}`);
    const lead = low.slice(0, 120);
    if (
      hasPatronymicMismatch &&
      !lead.includes(ownFull) &&
      !lead.includes(lower(`${full.lastName} ${full.firstName}`))
    ) {
      titleAboutOtherPerson = true;
      signals.push("title_about_other_person");
    }
  }

  return {
    hasPatronymicMismatch,
    mismatchedPatronymics: [...new Set(mismatchedPatronymics)],
    hasSurnameOnlyMatch,
    hasMultiPersonSnippet,
    titleAboutOtherPerson,
    famousUnrelatedPerson,
    signals,
  };
}
