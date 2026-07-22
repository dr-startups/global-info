/**
 * Stage 2 — CanonicalClaim contract.
 * Separates evidence, source allegation, risk theme, materiality, and client wording.
 */

import { z } from "zod";
import { ContractEnvelopeSchema, SubjectRelevanceDecisionSchema } from "./common";

export const CANONICAL_CLAIMS_BUNDLE_SCHEMA_VERSION = "canonical-claims-v1" as const;
export const CANONICAL_CLAIMS_SUMMARY_SCHEMA_VERSION = "canonical-claims-summary-v1" as const;

/** Universal Stage-2 material themes (evidence-driven, not case-hardcoded). */
export const CANONICAL_THEME_IDS = [
  "criminal_judicial",
  "corruption_integrity",
  "sanctions_pep_rca_compliance",
  "political_public_exposure",
  "business_ownership_associates",
  "offshore_financial_transparency",
  "regulatory",
  "reputational_scandal",
  "family_personal_risk_relevant",
  "identity_mismatch",
] as const;

export const CanonicalThemeIdSchema = z.enum(CANONICAL_THEME_IDS);
export type CanonicalThemeId = z.infer<typeof CanonicalThemeIdSchema>;

export const ClaimKindSchema = z.enum([
  "FACT",
  "SOURCE_ALLEGATION",
  "DATABASE_STATUS",
  "OFFICIAL_RECORD",
  "CONTEXT",
]);
export type ClaimKind = z.infer<typeof ClaimKindSchema>;

export const MaterialityLevelSchema = z.enum([
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "CONTEXT_ONLY",
]);
export type MaterialityLevel = z.infer<typeof MaterialityLevelSchema>;

export const CanonicalClaimSchema = z.object({
  claimId: z.string().min(1),
  subjectId: z.string().min(1),
  fullClaimText: z.string().min(1),
  displayExcerpt: z.string().min(1),
  claimKind: ClaimKindSchema,
  subjectMatch: SubjectRelevanceDecisionSchema,
  confidence: z.number().min(0).max(1),
  themeIds: z.array(CanonicalThemeIdSchema).min(0),
  adverseType: z.string().nullable(),
  materialityLevel: MaterialityLevelSchema,
  materialityReasons: z.array(z.string()),
  namedEntities: z.array(z.string()),
  dates: z.array(z.string()),
  regions: z.array(z.string()),
  contradictions: z.array(z.string()),
  evidenceRefs: z.array(z.string()).min(1),
  sourceDomains: z.array(z.string()),
  provenance: z.object({
    providers: z.array(z.string()),
    reportRunIds: z.array(z.string()),
    findingIds: z.array(z.string()),
  }),
  originalTitle: z.string(),
  originalFullTextRef: z.string().nullable(),
  clientQualification: z.string(),
  recommendedAction: z.string(),
  dispositionRef: z.string().min(1),
  /** Hard override: material adverse cannot vanish from summary solely on aggregate score. */
  summaryOverrideRequired: z.boolean(),
});
export type CanonicalClaim = z.infer<typeof CanonicalClaimSchema>;

export const CanonicalClaimsBundleSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(CANONICAL_CLAIMS_BUNDLE_SCHEMA_VERSION),
  subjectId: z.string().min(1),
  claims: z.array(CanonicalClaimSchema),
  gates: z.object({
    CANONICAL_CLAIM_TRACE_COMPLETE: z.boolean(),
    MATERIAL_ADVERSE_WITHOUT_THEME: z.number().int().min(0),
    UNQUALIFIED_MEDIA_ALLEGATIONS: z.number().int().min(0),
    SUBJECT_UNIVERSALITY_PASS: z.boolean(),
  }),
});
export type CanonicalClaimsBundle = z.infer<typeof CanonicalClaimsBundleSchema>;

export const CanonicalClaimsSummarySchema = z.object({
  schemaVersion: z.literal(CANONICAL_CLAIMS_SUMMARY_SCHEMA_VERSION),
  caseId: z.string().min(1),
  datasetId: z.string().min(1),
  subjectId: z.string().min(1),
  claimCount: z.number().int().min(0),
  byTheme: z.record(z.number().int().min(0)),
  byClaimKind: z.record(z.number().int().min(0)),
  byMateriality: z.record(z.number().int().min(0)),
  summaryOverrideCount: z.number().int().min(0),
  gates: CanonicalClaimsBundleSchema.shape.gates,
  generatedAt: z.string().min(1),
});
export type CanonicalClaimsSummary = z.infer<typeof CanonicalClaimsSummarySchema>;
