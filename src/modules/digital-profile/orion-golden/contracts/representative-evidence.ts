/**
 * Stage 3 — RepresentativeEvidenceSelection contract.
 * Coverage-aware selection of 1–2 examples per material theme.
 */

import { z } from "zod";
import { ContractEnvelopeSchema } from "./common";
import {
  CanonicalThemeIdSchema,
  ClaimKindSchema,
  MaterialityLevelSchema,
} from "./canonical-claim";

export const REPRESENTATIVE_EVIDENCE_SCHEMA_VERSION =
  "representative-evidence-selection-v1" as const;
export const REPRESENTATIVE_COVERAGE_SCHEMA_VERSION =
  "representative-evidence-coverage-v1" as const;
export const EXCLUDED_MATERIALITY_SCHEMA_VERSION =
  "excluded-materiality-report-v1" as const;

export const SelectedRepresentativeSchema = z.object({
  claimId: z.string().min(1),
  themeId: CanonicalThemeIdSchema,
  rankInTheme: z.number().int().min(1).max(2),
  originalTitle: z.string(),
  sourceDomain: z.string(),
  displayExcerpt: z.string().min(1),
  fullClaimTextRef: z.string().min(1),
  claimKind: ClaimKindSchema,
  materialityLevel: MaterialityLevelSchema,
  evidenceRefs: z.array(z.string()).min(1),
  selectionReasons: z.array(z.string()),
  plotKey: z.string().min(1),
});
export type SelectedRepresentative = z.infer<typeof SelectedRepresentativeSchema>;

export const IsolatedSignificantItemSchema = z.object({
  claimId: z.string().min(1),
  reasonCode: z.string().min(1),
  materialityLevel: MaterialityLevelSchema,
  originalTitle: z.string(),
  sourceDomains: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  displayExcerpt: z.string().min(1),
  fullClaimTextRef: z.string().min(1),
});
export type IsolatedSignificantItem = z.infer<typeof IsolatedSignificantItemSchema>;

export const P1P2AccountSchema = z.object({
  findingId: z.string().min(1),
  status: z.enum(["IN_SUMMARY_SELECTION", "APPENDIX_WITH_REASON"]),
  reasonCode: z.string().min(1),
  claimIds: z.array(z.string()),
});
export type P1P2Account = z.infer<typeof P1P2AccountSchema>;

export const RepresentativeEvidenceSelectionSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(REPRESENTATIVE_EVIDENCE_SCHEMA_VERSION),
  subjectId: z.string().min(1),
  materialThemeIds: z.array(CanonicalThemeIdSchema),
  selectedByTheme: z.record(z.array(SelectedRepresentativeSchema)),
  isolatedSignificantItems: z.array(IsolatedSignificantItemSchema),
  p1p2Account: z.array(P1P2AccountSchema),
  gates: z.object({
    MATERIAL_THEME_COVERAGE: z.number().min(0).max(100),
    P1_P2_ACCOUNTED: z.number().min(0).max(100),
    SEMANTIC_EXCERPT_TRUNCATIONS: z.number().int().min(0),
  }),
});
export type RepresentativeEvidenceSelection = z.infer<
  typeof RepresentativeEvidenceSelectionSchema
>;

export const RepresentativeCoverageReportSchema = z.object({
  schemaVersion: z.literal(REPRESENTATIVE_COVERAGE_SCHEMA_VERSION),
  caseId: z.string().min(1),
  datasetId: z.string().min(1),
  subjectId: z.string().min(1),
  themes: z.array(
    z.object({
      themeId: CanonicalThemeIdSchema,
      materialityCeiling: MaterialityLevelSchema,
      selectedClaimIds: z.array(z.string()),
      evidenceRefs: z.array(z.string()),
      covered: z.boolean(),
    })
  ),
  generatedAt: z.string().min(1),
});
export type RepresentativeCoverageReport = z.infer<
  typeof RepresentativeCoverageReportSchema
>;

export const ExcludedMaterialityReportSchema = z.object({
  schemaVersion: z.literal(EXCLUDED_MATERIALITY_SCHEMA_VERSION),
  caseId: z.string().min(1),
  datasetId: z.string().min(1),
  excluded: z.array(
    z.object({
      claimId: z.string().min(1),
      materialityLevel: MaterialityLevelSchema,
      themeIds: z.array(CanonicalThemeIdSchema),
      reasonCode: z.string().min(1),
      evidenceRefs: z.array(z.string()),
    })
  ),
  generatedAt: z.string().min(1),
});
export type ExcludedMaterialityReport = z.infer<typeof ExcludedMaterialityReportSchema>;
