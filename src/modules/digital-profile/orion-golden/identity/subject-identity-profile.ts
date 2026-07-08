/**
 * R10.7b — Canonical subject identity profile for binding / disambiguation.
 */

export type SubjectFullNameRu = {
  lastName: string;
  firstName: string;
  patronymic?: string;
};

export type SubjectIdentityProfile = {
  version: "r10-7b-subject-identity-profile-v1";
  caseId: string;
  displayName: string;
  fullNameRu?: SubjectFullNameRu;
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
