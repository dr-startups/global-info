/**
 * Stage 2 — explainable materiality scorer for CanonicalClaim.
 */

import type {
  CanonicalThemeId,
  MaterialityLevel,
  ClaimKind,
} from "../contracts/canonical-claim";
import type { SubjectRelevanceDecision } from "../contracts/common";
import {
  SUMMARY_OVERRIDE_THEMES,
  themeSeverityWeight,
} from "./canonical-themes";

const AUTHORITATIVE_DOMAIN =
  /\.gov(?:[./]|$)|treasury\.|ofac\.|justice\.|europa\.eu|kad\.arbitr|nalog\.ru|court/iu;
const REPUTABLE_MEDIA =
  /reuters\.|nytimes\.|theguardian\.|bbc\.|ft\.com|wsj\.|bloomberg\.|cnbc\.|kommersant\.|rbc\.ru|vedomosti\.|interfax\.|tass\.|currenttime\./iu;
const DATABASE_DOMAIN =
  /world.?check|dowjones|lexis|rupep|opensanctions|opensanction/iu;

export type MaterialityInput = {
  themeIds: CanonicalThemeId[];
  subjectMatch: SubjectRelevanceDecision;
  confidence: number;
  claimKind: ClaimKind;
  sourceDomains: string[];
  evidenceCount: number;
  independentDomainCount: number;
  regions: string[];
  hasOfficialOrPrimary: boolean;
  adverseText: boolean;
  dispositionKeep: boolean;
};

export type MaterialityResult = {
  level: MaterialityLevel;
  reasons: string[];
  score: number;
  summaryOverrideRequired: boolean;
};

function subjectDirectness(match: SubjectRelevanceDecision): number {
  switch (match) {
    case "SUBJECT_MATCH":
      return 1;
    case "LIKELY_SUBJECT":
      return 0.65;
    case "AMBIGUOUS":
      return 0.35;
    case "INSUFFICIENT_IDENTIFIERS":
      return 0.25;
    case "OTHER_SUBJECT":
      return 0;
    default:
      return 0.2;
  }
}

function domainAuthority(domains: string[]): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0.25;
  if (domains.some((d) => AUTHORITATIVE_DOMAIN.test(d))) {
    score = 1;
    reasons.push("authoritative_or_official_domain");
  } else if (domains.some((d) => DATABASE_DOMAIN.test(d))) {
    score = 0.9;
    reasons.push("compliance_database_domain");
  } else if (domains.some((d) => REPUTABLE_MEDIA.test(d))) {
    score = 0.75;
    reasons.push("reputable_media_domain");
  } else if (domains.length > 0) {
    score = 0.4;
    reasons.push("generic_source_domain");
  }
  return { score, reasons };
}

function levelFromScore(score: number, contextOnly: boolean): MaterialityLevel {
  if (contextOnly) return "CONTEXT_ONLY";
  if (score >= 0.85) return "CRITICAL";
  if (score >= 0.7) return "HIGH";
  if (score >= 0.5) return "MEDIUM";
  if (score >= 0.3) return "LOW";
  return "CONTEXT_ONLY";
}

export function scoreMateriality(input: MaterialityInput): MaterialityResult {
  const reasons: string[] = [];
  if (!input.dispositionKeep && input.subjectMatch === "OTHER_SUBJECT") {
    return {
      level: "CONTEXT_ONLY",
      reasons: ["other_subject_excluded_from_subject_materiality"],
      score: 0,
      summaryOverrideRequired: false,
    };
  }

  const themeWeight =
    input.themeIds.length === 0
      ? input.adverseText
        ? 0.55
        : 0.2
      : Math.max(...input.themeIds.map(themeSeverityWeight));
  if (input.themeIds.length > 0) {
    reasons.push(`theme_severity:${input.themeIds.join("+")}`);
  } else if (input.adverseText) {
    reasons.push("adverse_text_without_legacy_theme");
  }

  const directness = subjectDirectness(input.subjectMatch);
  reasons.push(`subject_directness:${input.subjectMatch}`);

  const auth = domainAuthority(input.sourceDomains);
  reasons.push(...auth.reasons);

  let independentBoost = 0;
  if (input.independentDomainCount >= 2) {
    independentBoost = 0.12;
    reasons.push("independent_corroboration");
  } else if (input.evidenceCount >= 3) {
    independentBoost = 0.06;
    reasons.push("repeated_evidence");
  }

  let officialBoost = 0;
  if (input.hasOfficialOrPrimary || input.claimKind === "OFFICIAL_RECORD") {
    officialBoost = 0.12;
    reasons.push("primary_or_official_record");
  } else if (input.claimKind === "DATABASE_STATUS") {
    officialBoost = 0.1;
    reasons.push("database_status_signal");
  }

  const regionBoost = input.regions.length > 0 ? 0.04 : 0;
  if (regionBoost) reasons.push("geo_region_present");

  const confidenceTerm = Math.min(1, Math.max(0, input.confidence)) * 0.15;
  reasons.push(`confidence_term:${input.confidence.toFixed(2)}`);

  let score =
    themeWeight * 0.35 +
    directness * 0.25 +
    auth.score * 0.18 +
    independentBoost +
    officialBoost +
    regionBoost +
    confidenceTerm;

  if (input.claimKind === "CONTEXT" && !input.adverseText) {
    score *= 0.5;
    reasons.push("context_downweight");
  }

  const overrideThemes = input.themeIds.filter((t) => SUMMARY_OVERRIDE_THEMES.has(t));
  const summaryOverrideRequired =
    overrideThemes.length > 0 &&
    (input.subjectMatch === "SUBJECT_MATCH" || input.subjectMatch === "LIKELY_SUBJECT");

  if (summaryOverrideRequired) {
    reasons.push(`summary_override:${overrideThemes.join("+")}`);
    // Floor: override themes cannot fall below HIGH for SUBJECT_MATCH.
    if (input.subjectMatch === "SUBJECT_MATCH" && score < 0.7) {
      score = 0.7;
      reasons.push("summary_override_floor_high");
    } else if (input.subjectMatch === "LIKELY_SUBJECT" && score < 0.5) {
      score = 0.5;
      reasons.push("summary_override_floor_medium");
    }
  }

  const contextOnly =
    input.subjectMatch === "OTHER_SUBJECT" ||
    (!input.adverseText && input.themeIds.length === 0 && input.claimKind === "CONTEXT");

  const level = levelFromScore(score, contextOnly);
  return {
    level,
    reasons,
    score: Math.round(score * 1000) / 1000,
    summaryOverrideRequired,
  };
}
