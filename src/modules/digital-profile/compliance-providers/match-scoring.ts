/**
 * Stage C1 — deterministic compliance match scoring.
 * HIGH confidence does NOT mean a verified match — analyst review is always required.
 */

import type {
  ComplianceConfidenceLevel,
  ComplianceRiskType,
  MatchScoringInput,
  MatchScoringResult,
} from "./types";

const SEVERE_RISK: ReadonlySet<ComplianceRiskType> = new Set([
  "SANCTIONS",
  "PEP",
  "WATCHLIST",
  "LAW_ENFORCEMENT",
]);

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenSet(s: string): Set<string> {
  return new Set(norm(s).split(" ").filter(Boolean));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function yearOf(dob: string | null | undefined): string | null {
  if (!dob) return null;
  const m = dob.match(/\d{4}/);
  return m ? m[0] : null;
}

function scoreToConfidence(score: number): ComplianceConfidenceLevel {
  if (score >= 75) return "HIGH";
  if (score >= 45) return "MEDIUM";
  return "LOW";
}

export function computeMatchScore(input: MatchScoringInput): MatchScoringResult {
  const signals: string[] = [];
  let score = 0;

  const subj = norm(input.subjectFullName);
  const match = norm(input.matchedName);

  if (subj && match && subj === match) {
    score += 40;
    signals.push("exact_full_name");
  } else {
    const sim = jaccard(tokenSet(input.subjectFullName), tokenSet(input.matchedName));
    const namePts = Math.round(sim * 35);
    if (namePts > 0) {
      score += namePts;
      signals.push(`name_similarity_${namePts}`);
    }
  }

  const aliasPool = [...(input.subjectAliases ?? []), ...(input.matchedAliases ?? [])].map(norm);
  if (aliasPool.some((a) => a && (a === match || match.includes(a) || a.includes(match)))) {
    score += 15;
    signals.push("alias_match");
  }

  const sy = yearOf(input.subjectDob);
  const my = yearOf(input.matchedDob);
  if (sy && my && sy === my) {
    score += 15;
    signals.push("dob_year_match");
  }

  const sc = norm(input.subjectCountry ?? "");
  const mc = norm(input.matchedCountry ?? "");
  if (sc && mc && sc === mc) {
    score += 10;
    signals.push("country_match");
  }

  let severityBonus = 0;
  for (const rt of input.riskTypes) {
    if (SEVERE_RISK.has(rt)) severityBonus = Math.max(severityBonus, 10);
    else if (rt === "ADVERSE_MEDIA" || rt === "LEGAL") severityBonus = Math.max(severityBonus, 5);
  }
  if (severityBonus > 0) {
    score += severityBonus;
    signals.push("category_severity");
  }

  score = Math.min(100, Math.max(0, score));
  return {
    matchScore: score,
    confidence: scoreToConfidence(score),
    signals,
  };
}
