/**
 * Stage N1.3 — deterministic search-result classifier for ORION snapshot
 * highlighting.
 *
 * PURE + deterministic. No LLM, no network, no scraping. Classifies a single
 * stored search result into a richer taxonomy than the Prisma enum allows; the
 * result is persisted in `SearchResult.rawMetadata.riskClassification` (additive,
 * no migration). Wording is evidence-first and conservative: keyword hits are
 * "potential matches requiring manual review", never categorical conclusions.
 * A single weak topical hint never yields an adverse highlight on its own.
 */

import {
  adverseMediaDict,
  bankruptcyDict,
  biographyHints,
  corporateHints,
  criminalDict,
  investigationDict,
  legalDisputeDict,
  matchesAny,
  newsDomainHints,
  pepDict,
  sanctionsDict,
  socialDomains,
  wikipediaDomains,
  type ClassifierThemeDict,
} from "./dictionaries";

export type ResultClass =
  | "RELEVANT"
  | "NEUTRAL"
  | "SOCIAL_PROFILE"
  | "CORPORATE"
  | "NEWS"
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

/** Classes that, with sufficient confidence/override, draw a red frame. */
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
}

export interface ResultClassification {
  classification: ResultClass;
  riskTheme: ResultRiskTheme | null;
  confidence: ResultConfidence;
  rationale: string;
  matchedTerms: string[];
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

const NEUTRAL_RATIONALE = "No adverse signals detected; treated as non-risk evidence candidate.";

/**
 * Classifies one search result. Deterministic precedence:
 *   sanctions → criminal → adverse-media/corruption/fraud → legal/bankruptcy
 *   → PEP → neutral buckets (relevant/social/corporate/news) → neutral/unknown.
 * Risk classes only reach MEDIUM/HIGH when a *strong* term (or multiple signals)
 * is present; a lone weak hint stays LOW (no auto highlight).
 */
export function classifySearchResultRecord(input: ClassifyResultInput): ResultClassification {
  const title = (input.title ?? "").trim();
  const snippet = (input.snippet ?? "").trim();
  const text = `${title} ${snippet}`.toLowerCase();
  const domain = hostnameOf(input.url, input.domain);

  const hasText = text.trim().length > 0;

  // --- Risk signals (strong wins; conservative confidence) ---
  const sanctions = hits(text, sanctionsDict);
  if (sanctions.strong.length > 0) {
    return risky("SANCTIONS", "sanctions", "HIGH", sanctions.strong, "sanctions");
  }

  const criminal = hits(text, criminalDict);
  if (criminal.strong.length > 0) {
    const conf: ResultConfidence = criminal.strong.length >= 2 ? "HIGH" : "MEDIUM";
    return risky("CRIMINAL", "criminal", conf, criminal.strong, "criminal");
  }

  const adverse = hits(text, adverseMediaDict);
  const investigation = hits(text, investigationDict);
  if (adverse.strong.length > 0) {
    const signals = adverse.strong.length + (investigation.weak.length > 0 ? 1 : 0);
    const conf: ResultConfidence = signals >= 2 ? "HIGH" : "MEDIUM";
    return risky(
      "ADVERSE_MEDIA",
      "adverse_media",
      conf,
      [...adverse.strong, ...investigation.weak],
      "adverse media"
    );
  }

  const legal = hits(text, legalDisputeDict);
  const bankruptcy = hits(text, bankruptcyDict);
  if (legal.strong.length > 0 || bankruptcy.strong.length > 0) {
    const matched = [...legal.strong, ...bankruptcy.strong];
    const conf: ResultConfidence = matched.length >= 2 ? "HIGH" : "MEDIUM";
    return risky("LEGAL_DISPUTE", "legal_dispute", conf, matched, "legal dispute");
  }

  // Weak-only adverse/legal/investigation hints → LOW, non-highlighting.
  const weakAdverse = [
    ...adverse.weak,
    ...legal.weak,
    ...bankruptcy.weak,
    ...investigation.weak,
    ...criminal.weak,
  ];
  if (weakAdverse.length > 0) {
    return {
      classification: weakAdverse.length >= 3 ? "ADVERSE_MEDIA" : "NEUTRAL",
      riskTheme: weakAdverse.length >= 3 ? "adverse_media" : null,
      confidence: "LOW",
      rationale: `Weak topical hint(s) only (${weakAdverse.slice(0, 3).join(", ")}); requires manual review — not treated as adverse.`,
      matchedTerms: weakAdverse.slice(0, 5),
    };
  }

  // PEP / political exposure — risk-relevant but not adverse. Conservative: a
  // lone PEP term stays LOW (no auto highlight); strong markers reach MEDIUM.
  const pep = hits(text, pepDict);
  if (pep.strong.length > 0) {
    return risky("PEP", "political_exposure", "MEDIUM", pep.strong, "political exposure");
  }
  if (pep.weak.length > 0) {
    return {
      classification: "PEP",
      riskTheme: "political_exposure",
      confidence: "LOW",
      rationale: `Possible political-exposure term(s) (${pep.weak.slice(0, 3).join(", ")}); requires manual review.`,
      matchedTerms: pep.weak.slice(0, 5),
    };
  }

  // --- Neutral buckets (no risk signals) ---
  if (wikipediaDomains.some((d) => domain.includes(d)) || biographyHints.some((b) => text.includes(b))) {
    return neutral("RELEVANT", "Authoritative/biographical profile; informational, non-adverse.");
  }
  if (socialDomains.some((d) => domain.includes(d))) {
    return neutral("SOCIAL_PROFILE", "Social/profile page; informational, non-adverse.");
  }
  if (corporateHints.some((h) => text.includes(h))) {
    return neutral("CORPORATE", "Corporate/company profile; informational, non-adverse.");
  }
  if (newsDomainHints.some((d) => domain.includes(d))) {
    return neutral("NEWS", "News article without adverse terms; informational.");
  }
  if (!hasText) {
    return {
      classification: "UNKNOWN",
      riskTheme: null,
      confidence: "LOW",
      rationale: "Insufficient text to classify; requires manual review.",
      matchedTerms: [],
    };
  }
  return neutral("NEUTRAL", NEUTRAL_RATIONALE);
}

function risky(
  classification: ResultClass,
  theme: ResultRiskTheme,
  confidence: ResultConfidence,
  matched: string[],
  label: string
): ResultClassification {
  return {
    classification,
    riskTheme: theme,
    confidence,
    rationale: `Potential ${label} match (terms: ${matched.slice(0, 3).join(", ")}). Requires manual verification; not a confirmed fact.`,
    matchedTerms: Array.from(new Set(matched)).slice(0, 5),
  };
}

function neutral(classification: ResultClass, rationale: string): ResultClassification {
  return { classification, riskTheme: null, confidence: "LOW", rationale, matchedTerms: [] };
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
