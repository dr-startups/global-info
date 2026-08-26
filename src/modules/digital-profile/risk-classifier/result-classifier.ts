/**
 * Stage N1.3 + R1.1.3 — deterministic search-result classifier for ORION snapshot
 * highlighting.
 *
 * PURE + deterministic. Conservative: registry/social/biography/namesake rows
 * never auto-highlight; legal/adverse requires strong keywords + identity match.
 */

import {
  adverseMediaDict,
  authorityBiographyHints,
  bankruptcyDict,
  biographyHints,
  corporateHints,
  corporateRegistryDomains,
  criminalDict,
  investigationDict,
  legalDisputeDict,
  matchesAny,
  newsDomainHints,
  pepDict,
  sanctionsDict,
  socialDomains,
  weakRegistryTerms,
  wikipediaDomains,
  type ClassifierThemeDict,
} from "./dictionaries";
import {
  assessIdentityMatch,
  isLikelyNamesake,
  parseSubjectName,
  type IdentityConfidence,
} from "./entity-disambiguation";

export type ResultClass =
  | "RELEVANT"
  | "NEUTRAL"
  | "SOCIAL_PROFILE"
  | "CORPORATE"
  | "CORPORATE_REGISTRY"
  | "NEWS"
  | "BIOGRAPHY"
  | "AUTHORITY"
  | "NAMESAKE"
  | "ENTITY_MISMATCH"
  | "ADVERSE_MEDIA"
  | "SANCTIONS"
  | "PEP"
  | "CRIMINAL"
  | "LEGAL_DISPUTE"
  | "HIGH_RISK"
  | "UNKNOWN";

export type ResultRiskTheme =
  | "sanctions"
  | "pep"
  | "legal_dispute"
  | "adverse_media"
  | "criminal"
  | "reputation"
  | "political_exposure"
  | "business_conflict"
  | "other";

export type ResultConfidence = "LOW" | "MEDIUM" | "HIGH";

/** Classes that may draw a red frame when combined with strong identity + HIGH risk confidence. */
export const RISKY_RESULT_CLASSES: ReadonlySet<ResultClass> = new Set<ResultClass>([
  "ADVERSE_MEDIA",
  "SANCTIONS",
  "PEP",
  "CRIMINAL",
  "LEGAL_DISPUTE",
  "HIGH_RISK",
]);

export function isRiskyResultClass(c: string | null | undefined): boolean {
  return !!c && RISKY_RESULT_CLASSES.has(c as ResultClass);
}

/** Maps a risky class to its default theme when none is explicitly provided. */
export function themeForClass(c: string | null | undefined): ResultRiskTheme {
  switch ((c ?? "").toUpperCase()) {
    case "SANCTIONS":
      return "sanctions";
    case "PEP":
      return "political_exposure";
    case "CRIMINAL":
      return "criminal";
    case "LEGAL_DISPUTE":
    case "LEGAL":
      return "legal_dispute";
    case "ADVERSE_MEDIA":
      return "adverse_media";
    case "HIGH_RISK":
      return "adverse_media";
    default:
      return "other";
  }
}

export interface ClassifyResultInput {
  title?: string | null;
  url?: string | null;
  domain?: string | null;
  snippet?: string | null;
  provider?: string | null;
  source?: string | null;
  query?: string | null;
  language?: string | null;
  region?: string | null;
  /** Audit subject full name — enables namesake / identity guards (R1.1.3). */
  subjectFullName?: string | null;
}

export interface ResultClassification {
  classification: ResultClass;
  riskTheme: ResultRiskTheme | null;
  confidence: ResultConfidence;
  /** Alias of confidence for snapshot highlight policy. */
  riskConfidence: ResultConfidence;
  identityConfidence: IdentityConfidence;
  rationale: string;
  matchedTerms: string[];
  /** True when the row may appear in review queues but must not auto-highlight. */
  potentialRiskForReview: boolean;
}

function hostnameOf(url: string | null | undefined, fallback: string | null | undefined): string {
  if (fallback && fallback.trim()) return fallback.trim().toLowerCase();
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function hits(text: string, dict: ClassifierThemeDict): { strong: string[]; weak: string[] } {
  return { strong: matchesAny(text, dict.strong), weak: matchesAny(text, dict.weak) };
}

function isRegistryDomain(domain: string): boolean {
  return corporateRegistryDomains.some((d) => domain.includes(d));
}

function hasOnlyWeakRegistrySignals(text: string): boolean {
  const weak = matchesAny(text, weakRegistryTerms);
  const legal = hits(text, legalDisputeDict);
  const criminal = hits(text, criminalDict);
  const adverse = hits(text, adverseMediaDict);
  const sanctions = hits(text, sanctionsDict);
  const strongRisk =
    legal.strong.length +
      criminal.strong.length +
      adverse.strong.length +
      sanctions.strong.length >
    0;
  return weak.length > 0 && !strongRisk;
}

const NEUTRAL_RATIONALE = "No adverse signals detected; treated as non-risk evidence candidate.";

/**
 * Classifies one search result. R1.1.3 tightens auto-risk: registry/social/
 * biography/namesake buckets first; strong keywords + identity match for highlights.
 */
export function classifySearchResultRecord(input: ClassifyResultInput): ResultClassification {
  const title = (input.title ?? "").trim();
  const snippet = (input.snippet ?? "").trim();
  // Identity resolution gets the text as it came: the namesake signal reads the
  // case of the word after the surname, and pre-lowercased text strips it away.
  const rawText = `${title} ${snippet}`.trim();
  const text = `${title} ${snippet}`.toLowerCase();
  const domain = hostnameOf(input.url, input.domain);
  const hasText = text.trim().length > 0;

  const subject = input.subjectFullName?.trim()
    ? parseSubjectName(input.subjectFullName.trim())
    : null;
  const identityConfidence = assessIdentityMatch(rawText, subject);

  // --- Corporate registry / business directory rows (before namesake guard) ---
  if (isRegistryDomain(domain) || hasOnlyWeakRegistrySignals(text)) {
    if (isRegistryDomain(domain) || matchesAny(text, weakRegistryTerms).length >= 2) {
      return neutralClass(
        "CORPORATE_REGISTRY",
        "LOW",
        identityConfidence,
        "Business registry or directory listing; informational unless strong legal/enforcement terms are present."
      );
    }
  }

  if (socialDomains.some((d) => domain.includes(d))) {
    return neutralClass("SOCIAL_PROFILE", "LOW", identityConfidence, "Social/profile page; informational, non-adverse.");
  }

  // --- Namesake / entity mismatch ---
  if (subject && isLikelyNamesake(rawText, subject)) {
    return neutralClass("NAMESAKE", "LOW", identityConfidence, "Different person with similar surname/name; not treated as the audit subject.");
  }

  if (
    wikipediaDomains.some((d) => domain.includes(d)) ||
    biographyHints.some((b) => text.includes(b)) ||
    authorityBiographyHints.some((b) => text.includes(b))
  ) {
    return neutralClass("BIOGRAPHY", "LOW", identityConfidence, "Biographical/authority source; informational, non-adverse.");
  }

  // --- Risk signals (strong only; identity gates auto highlight downstream) ---
  const sanctions = hits(text, sanctionsDict);
  if (sanctions.strong.length > 0 && identityConfidence !== "LOW") {
    return risky("SANCTIONS", "sanctions", "HIGH", identityConfidence, sanctions.strong, "sanctions");
  }

  const criminal = hits(text, criminalDict);
  if (criminal.strong.length > 0 && identityConfidence !== "LOW") {
    const conf: ResultConfidence = criminal.strong.length >= 2 ? "HIGH" : "MEDIUM";
    return risky("CRIMINAL", "criminal", conf, identityConfidence, criminal.strong, "criminal");
  }

  const adverse = hits(text, adverseMediaDict);
  const investigation = hits(text, investigationDict);
  if (adverse.strong.length > 0 && identityConfidence !== "LOW") {
    const signals = adverse.strong.length + (investigation.weak.length > 0 ? 1 : 0);
    const conf: ResultConfidence = signals >= 2 ? "HIGH" : "MEDIUM";
    return risky(
      "ADVERSE_MEDIA",
      "adverse_media",
      conf,
      identityConfidence,
      [...adverse.strong, ...investigation.weak],
      "adverse media"
    );
  }

  const legal = hits(text, legalDisputeDict);
  const bankruptcy = hits(text, bankruptcyDict);
  if ((legal.strong.length > 0 || bankruptcy.strong.length > 0) && identityConfidence !== "LOW") {
    const matched = [...legal.strong, ...bankruptcy.strong];
    const conf: ResultConfidence = matched.length >= 2 ? "HIGH" : "MEDIUM";
    return risky("LEGAL_DISPUTE", "legal_dispute", conf, identityConfidence, matched, "legal dispute");
  }

  // Weak-only hints → review candidate, never auto-highlight.
  const weakAdverse = [
    ...adverse.weak,
    ...legal.weak,
    ...bankruptcy.weak,
    ...investigation.weak,
    ...criminal.weak,
  ];
  if (weakAdverse.length > 0) {
    return {
      classification: "NEUTRAL",
      riskTheme: null,
      confidence: "LOW",
      riskConfidence: "LOW",
      identityConfidence,
      rationale: `Weak topical hint(s) only (${weakAdverse.slice(0, 3).join(", ")}); requires manual review — not treated as adverse.`,
      matchedTerms: weakAdverse.slice(0, 5),
      potentialRiskForReview: weakAdverse.length >= 2,
    };
  }

  const pep = hits(text, pepDict);
  if (pep.strong.length > 0 && identityConfidence !== "LOW") {
    return risky("PEP", "political_exposure", "MEDIUM", identityConfidence, pep.strong, "political exposure");
  }
  if (pep.weak.length > 0) {
    return {
      classification: "PEP",
      riskTheme: "political_exposure",
      confidence: "LOW",
      riskConfidence: "LOW",
      identityConfidence,
      rationale: `Possible political-exposure term(s) (${pep.weak.slice(0, 3).join(", ")}); requires manual review.`,
      matchedTerms: pep.weak.slice(0, 5),
      potentialRiskForReview: true,
    };
  }

  if (corporateHints.some((h) => text.includes(h))) {
    return neutralClass("CORPORATE", "LOW", identityConfidence, "Corporate/company profile; informational, non-adverse.");
  }
  if (newsDomainHints.some((d) => domain.includes(d))) {
    return neutralClass("NEWS", "LOW", identityConfidence, "News article without adverse terms; informational.");
  }
  if (!hasText) {
    return {
      classification: "UNKNOWN",
      riskTheme: null,
      confidence: "LOW",
      riskConfidence: "LOW",
      identityConfidence,
      rationale: "Insufficient text to classify; requires manual review.",
      matchedTerms: [],
      potentialRiskForReview: false,
    };
  }
  return neutralClass("NEUTRAL", "LOW", identityConfidence, NEUTRAL_RATIONALE);
}

function risky(
  classification: ResultClass,
  theme: ResultRiskTheme,
  riskConfidence: ResultConfidence,
  identityConfidence: IdentityConfidence,
  matched: string[],
  label: string
): ResultClassification {
  return {
    classification,
    riskTheme: theme,
    confidence: riskConfidence,
    riskConfidence,
    identityConfidence,
    rationale: `Potential ${label} match (terms: ${matched.slice(0, 3).join(", ")}). Requires manual verification; not a confirmed fact.`,
    matchedTerms: Array.from(new Set(matched)).slice(0, 5),
    potentialRiskForReview: riskConfidence !== "HIGH" || identityConfidence === "LOW",
  };
}

function neutralClass(
  classification: ResultClass,
  riskConfidence: ResultConfidence,
  identityConfidence: IdentityConfidence,
  rationale: string
): ResultClassification {
  return {
    classification,
    riskTheme: null,
    confidence: riskConfidence,
    riskConfidence,
    identityConfidence,
    rationale,
    matchedTerms: [],
    potentialRiskForReview: false,
  };
}

// ---------------------------------------------------------------------------
// rawMetadata persistence helpers (namespaced, non-destructive)
// ---------------------------------------------------------------------------

export interface AutoResultClassification extends ResultClassification {
  classifiedAt: string;
}

export interface ManualResultClassification {
  classification: ResultClass;
  riskTheme: ResultRiskTheme | null;
  rationale: string | null;
  reviewedBy: string | null;
  reviewedAt: string;
}

export interface StoredRiskClassification {
  auto?: AutoResultClassification | null;
  manual?: ManualResultClassification | null;
}

/** Reads the namespaced riskClassification block from a rawMetadata value. */
export function readRiskClassification(rawMetadata: unknown): StoredRiskClassification | null {
  if (!rawMetadata || typeof rawMetadata !== "object") return null;
  const block = (rawMetadata as Record<string, unknown>).riskClassification;
  if (!block || typeof block !== "object") return null;
  return block as StoredRiskClassification;
}

/** Returns a new rawMetadata object with riskClassification merged in (non-destructive). */
export function mergeRiskClassification(
  rawMetadata: unknown,
  next: StoredRiskClassification
): Record<string, unknown> {
  const base =
    rawMetadata && typeof rawMetadata === "object"
      ? { ...(rawMetadata as Record<string, unknown>) }
      : {};
  const prev = (base.riskClassification as StoredRiskClassification) ?? {};
  base.riskClassification = { ...prev, ...next };
  return base;
}

/** R1.1.3 — whether automatic classification qualifies for snapshot red frames. */
export function isStrongAutoSnapshotRisk(auto: AutoResultClassification | null | undefined): boolean {
  if (!auto || !isRiskyResultClass(auto.classification)) return false;
  const riskConf = auto.riskConfidence ?? auto.confidence;
  const identity = auto.identityConfidence ?? "LOW";
  return riskConf === "HIGH" && identity !== "LOW";
}
