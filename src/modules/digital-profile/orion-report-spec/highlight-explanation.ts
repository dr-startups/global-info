/**
 * Structured highlight explanations for ORION First36 client visuals.
 * Reasons must never be recovered by splitting captions on "." (breaks domains).
 */

export type HighlightRiskCategory =
  | "adverse_source"
  | "sanctions_pep"
  | "criminal_legal"
  | "reputational"
  | "namesake_confusion"
  | "unverified";

export type HighlightIdentityStatus =
  | "confirmed_subject"
  | "likely_subject"
  | "namesake"
  | "unrelated"
  | "unverified";

export type HighlightFrameTone = "red" | "amber" | "none";

export type HighlightExplanation = {
  evidenceRef: string;
  itemIndex: number;
  displayLabel: string;
  sourceDomain: string;
  riskCategory: HighlightRiskCategory;
  identityStatus: HighlightIdentityStatus;
  clientReason: string;
  confidence: "high" | "medium" | "low";
  frameTone: HighlightFrameTone;
};

const TLD_ONLY = new Set(["com", "online", "info", "org", "net", "ru", "io", "co", "uk", "de", "fr"]);

/** Registrable-looking domain; rejects bare TLDs. */
export function isValidSourceDomain(domain: string): boolean {
  const d = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/^www\./, "");
  if (!d || TLD_ONLY.has(d)) return false;
  if (!d.includes(".")) return false;
  const labels = d.split(".");
  if (labels.length < 2) return false;
  if (labels.some((l) => !l || l.length > 63)) return false;
  // Last label alone must not be the whole "domain" we accept as reason subject.
  return labels[0]!.length >= 1 && labels[labels.length - 1]!.length >= 2;
}

export function assertValidHighlightExplanation(ex: HighlightExplanation): void {
  if (!ex.evidenceRef?.trim()) throw new Error("highlightExplanation missing evidenceRef");
  if (!ex.clientReason?.trim()) throw new Error("highlightExplanation missing clientReason");
  if (!ex.identityStatus) throw new Error("highlightExplanation missing identityStatus");
  if (!isValidSourceDomain(ex.sourceDomain) && !/^[^.]{3,}$/u.test(ex.displayLabel)) {
    throw new Error(`highlightExplanation invalid sourceDomain/TLD: ${ex.sourceDomain}`);
  }
  if (ex.frameTone === "red" && (ex.identityStatus === "namesake" || ex.identityStatus === "unrelated" || ex.identityStatus === "unverified")) {
    throw new Error(`red frame forbidden for identityStatus=${ex.identityStatus}`);
  }
}

/** Red solid only for confirmed/likely subject with adverse reason; else amber/none. */
export function resolveFrameTone(
  identityStatus: HighlightIdentityStatus,
  hasAdverseSignal: boolean
): HighlightFrameTone {
  if (!hasAdverseSignal) return "none";
  if (identityStatus === "confirmed_subject" || identityStatus === "likely_subject") return "red";
  if (identityStatus === "unrelated") return "none";
  return "amber";
}

export function wordCount(text: string): number {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
}

export function clipWordsComplete(text: string, maxWords: number): string {
  const words = String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length <= maxWords) {
    const full = words.join(" ").trim();
    return /[.!?…]$/.test(full) ? full : full.replace(/[,:;—–-]\s*$/, "").trim();
  }
  // Prefer ending on sentence if present in prefix.
  const prefix = words.slice(0, maxWords).join(" ");
  const punct = Math.max(prefix.lastIndexOf("."), prefix.lastIndexOf("!"), prefix.lastIndexOf("?"));
  if (punct > prefix.length * 0.4) return prefix.slice(0, punct + 1).trim();
  let out = prefix.replace(/[,:;—–-]\s*$/, "").trim();
  // Never leave dangling initials / "в т.ч."
  out = out.replace(/\s+(?:в\s+т\.?\s*ч\.?|с\s+[А-ЯA-Z]\.?|[А-ЯA-Z]\.?)\s*$/u, "").trim();
  if (!/[.!?…]$/.test(out) && out.length > 0) {
    // Keep as complete clause without fake ellipsis.
    return out;
  }
  return out;
}
