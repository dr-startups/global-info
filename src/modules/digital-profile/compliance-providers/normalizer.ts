/**
 * Stage C1 — normalize compliance hits to the unified shape.
 */

import type {
  ComplianceHitReviewStatus,
  ComplianceProviderName,
  ComplianceRiskType,
  ComplianceScreeningHit,
  ComplianceHitSource,
  ComplianceConfidenceLevel,
} from "./types";

export interface RawHitInput {
  provider: ComplianceProviderName;
  source: ComplianceHitSource;
  screeningRunId?: string;
  subjectName: string;
  matchedName: string;
  aliases?: string[];
  categories?: string[];
  riskTypes?: ComplianceRiskType[];
  countries?: string[];
  datesOfBirth?: string[];
  matchScore: number;
  confidence: ComplianceConfidenceLevel;
  profileId?: string;
  profileUrl?: string;
  summary: string;
  extraMetadata?: Record<string, unknown>;
  reviewStatus?: ComplianceHitReviewStatus;
}

/** Strips secret-like keys from metadata before persistence. */
export function sanitizeRawMetadata(meta: Record<string, unknown>): Record<string, unknown> {
  const forbidden = /api[-_]?key|secret|password|token|client[-_]?secret|authorization/i;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (forbidden.test(k)) continue;
    if (typeof v === "string" && forbidden.test(v)) continue;
    out[k] = v;
  }
  return out;
}

export function normalizeComplianceHit(input: RawHitInput): ComplianceScreeningHit {
  return {
    provider: input.provider,
    source: input.source,
    screeningRunId: input.screeningRunId,
    subjectName: input.subjectName,
    matchedName: input.matchedName,
    aliases: input.aliases ?? [],
    categories: input.categories ?? [],
    riskTypes: input.riskTypes ?? [],
    countries: input.countries ?? [],
    datesOfBirth: input.datesOfBirth ?? [],
    matchScore: input.matchScore,
    confidence: input.confidence,
    profileId: input.profileId,
    profileUrl: input.profileUrl,
    summary: input.summary,
    rawMetadataSafe: sanitizeRawMetadata({
      manualImport: input.source === "MANUAL",
      providerLabel: input.provider,
      ...(input.extraMetadata ?? {}),
    }),
    reviewStatus: input.reviewStatus ?? "PENDING",
  };
}

export function riskTypesToMatchType(riskTypes: ComplianceRiskType[]): string {
  return riskTypes.length > 0 ? riskTypes.join(", ") : "POTENTIAL_MATCH";
}
