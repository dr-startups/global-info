/**
 * Stage 4 — ClientSummaryPack contract.
 * Sole typed input for executive summary content (not wired to renderer yet).
 */

import { z } from "zod";
import { ContractEnvelopeSchema, RiskLevelSchema } from "./common";
import {
  CanonicalThemeIdSchema,
  ClaimKindSchema,
  MaterialityLevelSchema,
} from "./canonical-claim";

export const CLIENT_SUMMARY_PACK_SCHEMA_VERSION = "client-summary-pack-v1" as const;

export const RepresentativeArticleSchema = z.object({
  title: z.string().min(1),
  domain: z.string().min(1),
  sourceDate: z.string().nullable(),
  conciseCompleteDescription: z.string().min(1),
  sourceAllegationOrStatus: z.string().min(1),
  evidenceRefs: z.array(z.string()).min(1),
  confidence: z.number().min(0).max(1),
  materialityLevel: MaterialityLevelSchema,
  clientQualification: z.string().min(1),
  claimKind: ClaimKindSchema,
});
export type RepresentativeArticle = z.infer<typeof RepresentativeArticleSchema>;

export const ClientMaterialThemeSchema = z.object({
  themeId: CanonicalThemeIdSchema,
  clientTitle: z.string().min(1),
  conclusion: z.string().min(1),
  concreteClaims: z.array(z.string()).min(1),
  representativeArticles: z.array(RepresentativeArticleSchema).min(1),
  whyItMatters: z.string().min(1),
  qualification: z.string().min(1),
  recommendedChecks: z.array(z.string()).min(1),
  materialityLevel: MaterialityLevelSchema,
  evidenceRefs: z.array(z.string()).min(1),
  sourceDomains: z.array(z.string()).min(1),
});
export type ClientMaterialTheme = z.infer<typeof ClientMaterialThemeSchema>;

export const ClientIsolatedItemSchema = z.object({
  title: z.string().min(1),
  domain: z.string().min(1),
  description: z.string().min(1),
  qualification: z.string().min(1),
  materialityLevel: MaterialityLevelSchema,
  evidenceRefs: z.array(z.string()).min(1),
});
export type ClientIsolatedItem = z.infer<typeof ClientIsolatedItemSchema>;

export const InternationalDatabaseEntrySchema = z.object({
  databaseName: z.string().min(1),
  statusSummary: z.string().min(1),
  qualification: z.string().min(1),
  evidenceRefs: z.array(z.string()),
  sourceDomains: z.array(z.string()),
});
export type InternationalDatabaseEntry = z.infer<typeof InternationalDatabaseEntrySchema>;

export const ClientSummaryPackSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(CLIENT_SUMMARY_PACK_SCHEMA_VERSION),
  subjectId: z.string().min(1),
  scope: z.object({
    regions: z.array(z.string()),
    sourceClasses: z.array(z.string()),
    surfaces: z.array(z.string()),
    period: z.object({
      collectedLabel: z.string(),
      newestLabel: z.string().nullable(),
    }),
    coverageLimitations: z.array(z.string()),
  }),
  overallAssessment: z.object({
    riskLevel: RiskLevelSchema,
    conclusion: z.string().min(1),
    reasons: z.array(z.string()).min(1),
    limitations: z.array(z.string()),
    evidenceRefs: z.array(z.string()).min(1),
  }),
  materialThemes: z.array(ClientMaterialThemeSchema),
  isolatedSignificantItems: z.array(ClientIsolatedItemSchema),
  internationalDatabases: z.array(InternationalDatabaseEntrySchema),
  changesSinceBaseline: z.object({
    summary: z.string(),
    addedCount: z.number().int().min(0).nullable(),
    removedCount: z.number().int().min(0).nullable(),
  }),
  nextSteps: z.array(z.string()).min(1),
  /** Machine-only; must not be copied into client slide fields as-is. */
  trace: z.object({
    claimIds: z.array(z.string()),
    findingIds: z.array(z.string()),
    dispositionRefs: z.array(z.string()),
    representativeSelectionRef: z.string(),
    canonicalClaimsRef: z.string(),
    p1p2Account: z.array(
      z.object({
        findingId: z.string(),
        status: z.string(),
        reasonCode: z.string(),
      })
    ),
  }),
  gates: z.object({
    CLIENT_SUMMARY_PACK_VALID: z.boolean(),
    MATERIAL_THEMES_MISSING: z.number().int().min(0),
    CLIENT_ASSERTIONS_WITHOUT_EVIDENCE: z.number().int().min(0),
    INTERNAL_TOKENS_IN_CLIENT_FIELDS: z.number().int().min(0),
  }),
});
export type ClientSummaryPack = z.infer<typeof ClientSummaryPackSchema>;
