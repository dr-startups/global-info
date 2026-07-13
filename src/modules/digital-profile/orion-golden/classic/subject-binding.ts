/**
 * Typed subject binding for First36 identity pipeline.
 * Must flow evidence → asset → visual analysis → sidebar.
 */

export type SubjectBinding =
  | "CONFIRMED_SUBJECT"
  | "PROBABLE_SUBJECT"
  | "AMBIGUOUS"
  | "WRONG_SUBJECT"
  | "UNRESOLVED";

export type IdentityConfidence = "high" | "medium" | "low" | "none";

export type SubjectIdentityFields = {
  subjectBinding: SubjectBinding;
  identityConfidence: IdentityConfidence;
  identityReasonCodes: string[];
};

export function isWrongOrAmbiguousBinding(binding: SubjectBinding | undefined): boolean {
  return binding === "WRONG_SUBJECT" || binding === "AMBIGUOUS";
}

export function bindingFromWikipediaStatus(
  status: string | undefined
): SubjectIdentityFields {
  switch (String(status ?? "").toUpperCase()) {
    case "EXACT_SUBJECT":
      return {
        subjectBinding: "CONFIRMED_SUBJECT",
        identityConfidence: "high",
        identityReasonCodes: ["wikipedia_exact_subject"],
      };
    case "WRONG_SUBJECT":
      return {
        subjectBinding: "WRONG_SUBJECT",
        identityConfidence: "high",
        identityReasonCodes: ["wikipedia_wrong_subject"],
      };
    case "AMBIGUOUS":
      return {
        subjectBinding: "AMBIGUOUS",
        identityConfidence: "medium",
        identityReasonCodes: ["wikipedia_ambiguous"],
      };
    case "MISSING":
      return {
        subjectBinding: "UNRESOLVED",
        identityConfidence: "none",
        identityReasonCodes: ["wikipedia_missing"],
      };
    default:
      return {
        subjectBinding: "UNRESOLVED",
        identityConfidence: "none",
        identityReasonCodes: ["wikipedia_unknown"],
      };
  }
}

/** Client-safe label — never expose enum tokens. */
export function clientSubjectBindingLabel(binding: SubjectBinding): string {
  switch (binding) {
    case "CONFIRMED_SUBJECT":
      return "соответствует проверяемому лицу";
    case "PROBABLE_SUBJECT":
      return "вероятно относится к проверяемому лицу";
    case "AMBIGUOUS":
      return "принадлежность не подтверждена";
    case "WRONG_SUBJECT":
      return "другой субъект";
    case "UNRESOLVED":
      return "требует сверки личности";
  }
}
