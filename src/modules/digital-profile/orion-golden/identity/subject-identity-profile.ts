/**
 * R10.7b — Canonical subject identity profile for binding / disambiguation.
 */

export type SubjectFullNameRu = {
  lastName: string;
  firstName: string;
  patronymic?: string;
};

/** A specific homonym/namesake of the subject and its disambiguating noise. */
export type SubjectNamesakeProfile = {
  /** Client-facing label for the OTHER person, e.g. "Иван Петров (актёр)". */
  label: string;
  /** Tokens whose presence indicates this OTHER subject, not ours. */
  noiseTerms: string[];
};

export type SubjectIdentityProfile = {
  version: "r10-7b-subject-identity-profile-v1";
  caseId: string;
  displayName: string;
  fullNameRu?: SubjectFullNameRu;
  /**
   * Structured dynamic identity fields. Preferred over positional `fullNameRu`
   * for any subject. Positional parsing of `fullNameRu` is only a
   * lower-confidence backward-compat fallback and must not assume Russian name
   * order or the existence of a patronymic.
   */
  givenNames?: string[];
  familyNames?: string[];
  patronymics?: string[];
  /** Words that strengthen a match (occupation/sector/affiliation, subject-supplied). */
  contextIdentifiers?: string[];
  /** Known homonyms and their disambiguating noise terms (subject-supplied). */
  namesakeProfiles?: SubjectNamesakeProfile[];
  aliases: string[];
  transliterations: string[];
  queryVariants: string[];
  knownIdentifiers: {
    inn?: string[];
    ogrn?: string[];
    ogrnip?: string[];
    birthDate?: string[];
    companyNames?: string[];
    socialHandles?: string[];
    locations?: string[];
    domains?: string[];
  };
  negativeIdentitySignals: {
    wrongPatronymics: string[];
    wrongNames: string[];
    wrongBirthDates: string[];
    unrelatedKnownPersons: string[];
  };
  regionHints: string[];
  languageHints: string[];
};

export type SubjectBindingScoreResult = {
  binding: "CONFIRMED" | "LIKELY" | "WEAK" | "WRONG_SUBJECT" | "UNKNOWN";
  score: number;
  positiveSignals: string[];
  negativeSignals: string[];
  explanation: string;
};
