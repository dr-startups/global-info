/**
 * Deterministic risk rules (Stage I).
 *
 * Pure functions: each takes one evidence item and returns zero or more cautious
 * RiskClassificationResult objects. Wording is intentionally non-conclusive
 * ("mentions found", "requires manual review"). No LLM, no network.
 */

import {
  allNegativeKeywords,
  bankruptcyKeywords,
  criminalAllegationKeywords,
  legalKeywords,
  matchesAny,
  neutralSafeDomains,
  offshoreKeywords,
  pepKeywords,
  reputationDomains,
  sanctionsKeywords,
} from "./dictionaries";
import type {
  RiskClassificationResult,
  RiskEvidenceRef,
  RiskLevel,
  RiskSignalType,
  RiskTheme,
} from "./types";
import type {
  LoadedDatabaseProfile,
  LoadedSearchResult,
  LoadedSurfaceItem,
  LoadedWikipediaCheck,
} from "./evidence-loader";

function domainOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function isNeutralDomain(url: string | null): boolean {
  const d = domainOf(url);
  return neutralSafeDomains.some((n) => d.includes(n));
}

function make(
  signalType: RiskSignalType,
  theme: RiskTheme,
  riskLevel: RiskLevel,
  title: string,
  description: string,
  evidenceRefs: RiskEvidenceRef[],
  confidence: number,
  rationale: string,
  demo: boolean
): RiskClassificationResult {
  return { signalType, theme, riskLevel, title, description, evidenceRefs, confidence, rationale, demo };
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

interface KeywordRule {
  signalType: RiskSignalType;
  theme: RiskTheme;
  level: RiskLevel;
  keywords: string[];
  label: string;
}

const SEARCH_KEYWORD_RULES: KeywordRule[] = [
  { signalType: "SANCTIONS_MENTION", theme: "sanctions", level: "HIGH", keywords: sanctionsKeywords, label: "sanctions" },
  { signalType: "CRIMINAL_ALLEGATION", theme: "criminal_allegation", level: "HIGH", keywords: criminalAllegationKeywords, label: "criminal-allegation" },
  { signalType: "PEP_RCA_MENTION", theme: "pep_rca", level: "MEDIUM", keywords: pepKeywords, label: "PEP/RCA" },
  { signalType: "OFFSHORE_MENTION", theme: "offshore", level: "MEDIUM", keywords: offshoreKeywords, label: "offshore" },
  { signalType: "LEGAL_DISPUTE", theme: "legal", level: "MEDIUM", keywords: legalKeywords, label: "legal-dispute" },
  { signalType: "BANKRUPTCY_MENTION", theme: "legal", level: "MEDIUM", keywords: bankruptcyKeywords, label: "bankruptcy" },
];

export function classifySearchResult(r: LoadedSearchResult): RiskClassificationResult[] {
  const text = `${r.title ?? ""} ${r.snippet ?? ""} ${r.url}`;
  const demo = (r.source ?? "").startsWith("mock");
  const ref: RiskEvidenceRef = {
    type: "SEARCH_RESULT",
    id: r.id,
    title: r.title ?? undefined,
    url: r.url,
    provider: r.engine,
    source: r.source ?? undefined,
  };
  const results: RiskClassificationResult[] = [];

  for (const rule of SEARCH_KEYWORD_RULES) {
    const hits = matchesAny(text, rule.keywords);
    if (hits.length === 0) continue;
    results.push(
      make(
        rule.signalType,
        rule.theme,
        rule.level,
        `Possible ${rule.label} mention in open-source result`,
        `Mentions found (${hits.slice(0, 3).join(", ")}) in a search result. Requires manual verification; not a confirmed fact.`,
        [ref],
        0.55,
        `Keyword match (${rule.label}) on search result text.`,
        demo
      )
    );
  }

  // Reputation/"compromat" style domains.
  const domain = domainOf(r.url);
  if (reputationDomains.some((d) => domain.includes(d))) {
    results.push(
      make(
        "REPUTATION_SITE",
        "reputation",
        "MEDIUM",
        "Mention on a reputation/compromat-style source",
        `The result originates from ${domain}, a source often hosting unverified reputational claims. Requires manual review.`,
        [ref],
        0.6,
        "Hostname matched a known reputation-site marker.",
        demo
      )
    );
  }

  // Explicit adverse-media classification or negative keywords.
  const negHits = matchesAny(text, allNegativeKeywords);
  const isAdverse = r.classification === "ADVERSE_MEDIA" || negHits.length > 0;
  if (isAdverse) {
    const strong = r.classification === "ADVERSE_MEDIA";
    results.push(
      make(
        "ADVERSE_MEDIA",
        "adverse_media",
        strong ? "MEDIUM" : isNeutralDomain(r.url) ? "LOW" : "MEDIUM",
        "Potential adverse media",
        `Adverse-media indicators ${strong ? "(classified)" : `(${negHits.slice(0, 3).join(", ")})`} found in a search result. Requires manual verification.`,
        [ref],
        strong ? 0.8 : 0.5,
        strong ? "Result classified ADVERSE_MEDIA." : "Negative keyword match on result text.",
        demo
      )
    );
  }

  return results;
}

// ---------------------------------------------------------------------------
// Search surface items
// ---------------------------------------------------------------------------

export function classifySurfaceItem(s: LoadedSurfaceItem): RiskClassificationResult[] {
  const demo = s.source === "MOCK";
  const baseRef: RiskEvidenceRef = {
    type: "SEARCH_SURFACE_ITEM",
    id: s.id,
    title: s.title ?? s.query ?? undefined,
    url: s.url ?? undefined,
    provider: s.provider ?? undefined,
    source: s.source,
  };
  const results: RiskClassificationResult[] = [];
  const negClassification = ["NEGATIVE", "ADVERSE_MEDIA"].includes((s.classification ?? "").toUpperCase());

  if (s.type === "SUGGESTION" || s.type === "RELATED_QUERY") {
    const text = `${s.query ?? ""} ${s.title ?? ""}`;
    const hits = matchesAny(text, allNegativeKeywords);
    if (hits.length > 0) {
      results.push(
        make(
          "NEGATIVE_SUGGESTION",
          "search_profile",
          "LOW",
          "Negative search suggestion/related query",
          `A ${s.type === "SUGGESTION" ? "search suggestion" : "related query"} contains negative terms (${hits.slice(0, 3).join(", ")}). Indicates public interest in adverse topics; requires manual review.`,
          [baseRef],
          0.45,
          "Negative keyword match on suggestion/related query text.",
          demo
        )
      );
    }
  }

  if (s.type === "IMAGE_RESULT" && negClassification) {
    results.push(
      make("NEGATIVE_IMAGE", "reputation", "LOW", "Negatively classified image result",
        "An image result was marked as negative. Requires manual review.", [baseRef], 0.5,
        "Image result classification is negative/adverse.", demo)
    );
  }

  if (s.type === "VIDEO_RESULT" && negClassification) {
    results.push(
      make("NEGATIVE_VIDEO", "reputation", "LOW", "Negatively classified video result",
        "A video result was marked as negative. Requires manual review.", [baseRef], 0.5,
        "Video result classification is negative/adverse.", demo)
    );
  }

  if (s.type === "KNOWLEDGE_BLOCK") {
    const meta = (s.rawMetadata ?? {}) as Record<string, unknown>;
    const mismatch =
      meta.mismatch === true ||
      (s.classification ?? "").toUpperCase() === "MISMATCH" ||
      meta.manualFlag === true;
    if (mismatch) {
      results.push(
        make("KNOWLEDGE_BLOCK_MISMATCH", "search_profile", "LOW", "Knowledge block mismatch flagged",
          "The knowledge block was flagged as inconsistent with the subject. Requires manual review.", [baseRef], 0.5,
          "Knowledge block carries a mismatch/manual flag.", demo)
      );
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Wikipedia checks
// ---------------------------------------------------------------------------

export function classifyWikipedia(w: LoadedWikipediaCheck): RiskClassificationResult[] {
  const demo = (w.checkedBy ?? "").startsWith("mock");
  const ref: RiskEvidenceRef = {
    type: "WIKIPEDIA_CHECK",
    id: w.id,
    title: w.pageTitle ?? undefined,
    url: w.url ?? undefined,
    provider: "WIKIPEDIA",
    source: w.checkedBy ?? undefined,
  };
  const results: RiskClassificationResult[] = [];

  if (!w.exists) {
    results.push(
      make("WIKIPEDIA_ABSENT", "wikipedia", "LOW", "No authoritative Wikipedia profile found",
        "No Wikipedia page was found for the subject. This is the absence of a controlled authoritative profile, not an adverse signal; informational only.",
        [ref], 0.4, "Wikipedia check returned exists=false.", demo)
    );
    return results;
  }

  const extract = JSON.stringify(w.snapshot ?? {});
  const hits = matchesAny(extract, allNegativeKeywords);
  if (hits.length > 0) {
    results.push(
      make("ADVERSE_MEDIA", "adverse_media", "MEDIUM", "Adverse terms in Wikipedia extract",
        `The Wikipedia extract contains adverse terms (${hits.slice(0, 3).join(", ")}). Requires manual review.`,
        [ref], 0.55, "Negative keyword match in Wikipedia snapshot.", demo)
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Compliance database profiles
// ---------------------------------------------------------------------------

export function classifyDatabaseProfile(d: LoadedDatabaseProfile): RiskClassificationResult[] {
  const reviewStatus = d.reviewStatus ?? "PENDING";
  if (reviewStatus === "FALSE_POSITIVE" || reviewStatus === "DISMISSED") return [];

  const riskTypes = d.riskTypes ?? [];
  const matchType = (d.matchType ?? "").toUpperCase();
  const hasMaterialRisk =
    riskTypes.some((rt) =>
      ["SANCTIONS", "PEP", "WATCHLIST", "LAW_ENFORCEMENT", "ADVERSE_MEDIA"].includes(rt)
    ) || /PEP|RCA|SANCTION|ADVERSE/.test(matchType);

  if (!hasMaterialRisk && (d.matchScore ?? 0) < 45) return [];

  const isSanction = riskTypes.includes("SANCTIONS") || /SANCTION/.test(matchType);
  const level: RiskLevel =
    reviewStatus === "MATCH_CONFIRMED" && isSanction
      ? "CRITICAL"
      : reviewStatus === "MATCH_CONFIRMED"
        ? "HIGH"
        : "LOW";
  const theme: RiskTheme = isSanction
    ? "sanctions"
    : riskTypes.includes("PEP") || /PEP|RCA/.test(matchType)
      ? "pep_rca"
      : riskTypes.includes("ADVERSE_MEDIA") || /ADVERSE/.test(matchType)
        ? "adverse_media"
        : "compliance_database";

  const ref: RiskEvidenceRef = {
    type: "DATABASE_PROFILE",
    id: d.id,
    title: `${d.provider} ${d.matchType ?? "potential match"}`,
    provider: d.provider,
  };
  return [
    make(
      "COMPLIANCE_DATABASE_MATCH",
      theme,
      level,
      `Potential compliance match — ${d.provider}`,
      `A potential ${d.matchType ?? "match"} in ${d.provider} requires analyst review before any conclusion.${d.matchScore != null ? ` Match score ${d.matchScore} (not verified).` : ""}`,
      [ref],
      0.5,
      "Compliance database potential match — review required.",
      false
    ),
  ];
}
