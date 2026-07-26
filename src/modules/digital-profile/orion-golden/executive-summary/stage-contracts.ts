/**
 * EXECUTIVE_SUMMARY stage — input/output contracts.
 * Stage runs only after cross-surface findings (VerifiedFindingBundle) exist.
 * The model never receives the raw dataset or the PDF — only this reduced input.
 */

import { z } from "zod";
import { ContractEnvelopeSchema, SampleStatusSchema } from "../contracts/common";
import { FindingSchema } from "../contracts/finding";
import { VerifiedFindingBundleSchema } from "../contracts/verified-finding-bundle";

export const EXECUTIVE_SUMMARY_STAGE_INPUT_SCHEMA_VERSION =
  "executive-summary-stage-input-v1" as const;
export const EXECUTIVE_SUMMARY_STAGE_OUTPUT_SCHEMA_VERSION =
  "executive-summary-stage-v1" as const;

// ---------- Input ----------

export const SourceQualityEntrySchema = z.object({
  domain: z.string().min(1),
  reliability: z.enum(["AUTHORITATIVE", "REPUTABLE", "AGGREGATOR", "UNVERIFIED"]),
  conflictsWithDomains: z.array(z.string()).optional(),
});

export const ExecutiveSummaryStageInputSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(EXECUTIVE_SUMMARY_STAGE_INPUT_SCHEMA_VERSION),
  subject: z.object({
    displayName: z.string().min(1),
    aliases: z.array(z.string()),
    identifiers: z.array(z.string()),
  }),
  coverage: z.array(
    z.object({
      region: z.string().min(1),
      surface: z.string().min(1),
      sampleStatus: SampleStatusSchema,
    })
  ),
  regionalMetrics: z.array(
    z.object({
      region: z.string().min(1),
      adverseCount: z.number().int().nonnegative(),
      totalCount: z.number().int().nonnegative(),
      adverseSharePercent: z.number().min(0).max(100).nullable(),
    })
  ),
  verifiedFindings: VerifiedFindingBundleSchema,
  ambiguousFindings: z.array(FindingSchema),
  identityPollution: z.object({
    otherSubjectCount: z.number().int().nonnegative(),
    ambiguousCount: z.number().int().nonnegative(),
    dominantOtherSubject: z.string().nullable(),
    notes: z.array(z.string()),
  }),
  dataGaps: z.array(z.object({ area: z.string().min(1), detail: z.string().min(1) })),
  sourceQuality: z.array(SourceQualityEntrySchema),
  recommendedActions: z.array(z.string().min(1)),
});

export type ExecutiveSummaryStageInput = z.infer<typeof ExecutiveSummaryStageInputSchema>;
export type SourceQualityEntry = z.infer<typeof SourceQualityEntrySchema>;

// ---------- Output ----------

export const ExecutiveVerdictSchema = z.enum([
  "LOW",
  "MIXED",
  "ELEVATED",
  "HIGH",
  "INSUFFICIENT_DATA",
]);
export type ExecutiveVerdict = z.infer<typeof ExecutiveVerdictSchema>;

/** Confirmed fact vs preliminary signal vs hypothesis — must never be conflated. */
export const BasisKindSchema = z.enum(["CONFIRMED_FACT", "PRELIMINARY_SIGNAL", "HYPOTHESIS"]);
export type BasisKind = z.infer<typeof BasisKindSchema>;

export const ExecutiveKeyFindingSchema = z.object({
  findingId: z.string().min(1),
  title: z.string().min(1).max(140),
  basisKind: BasisKindSchema,
  factualBasis: z.string().min(1).max(320),
  clientImpact: z.string().min(1).max(220),
  confidence: z.number().min(0).max(1),
  recommendedAction: z.string().min(1).max(180),
});
export type ExecutiveKeyFinding = z.infer<typeof ExecutiveKeyFindingSchema>;

export const ExecutiveSummaryStageOutputSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(EXECUTIVE_SUMMARY_STAGE_OUTPUT_SCHEMA_VERSION),
  promptVersion: z.string().min(1),
  inputHash: z.string().min(1),
  verdict: ExecutiveVerdictSchema,
  executiveConclusion: z.string().min(1),
  keyFindings: z.array(ExecutiveKeyFindingSchema),
  regionalOverview: z.array(
    z.object({
      region: z.string().min(1),
      adverseSharePercent: z.number().min(0).max(100).nullable(),
      adverseCount: z.number().int().nonnegative().nullable(),
      totalCount: z.number().int().nonnegative().nullable(),
      oneLiner: z.string().min(1).max(220),
    })
  ),
  identityCaveats: z.array(z.string().min(1).max(320)),
  dataLimitations: z.array(z.string().min(1).max(320)),
  priorityActions: z.array(z.string().min(1).max(180)).min(1).max(6),
  methodologyNote: z.string().min(1).max(400),
}).superRefine((val, ctx) => {
  if (val.verdict === "INSUFFICIENT_DATA") {
    if (val.keyFindings.length !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "INSUFFICIENT_DATA must not carry keyFindings",
        path: ["keyFindings"],
      });
    }
    if (val.executiveConclusion.length < 120 || val.executiveConclusion.length > 600) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `INSUFFICIENT_DATA conclusion must be 120–600 chars, got ${val.executiveConclusion.length}`,
        path: ["executiveConclusion"],
      });
    }
    return;
  }
  // A verdict may legitimately rest on 1–3 solid findings (small but strong
  // corpora); the upper bound still caps the summary at 7 items.
  if (val.keyFindings.length < 1 || val.keyFindings.length > 7) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `keyFindings must have 1–7 items, got ${val.keyFindings.length}`,
      path: ["keyFindings"],
    });
  }
  if (val.executiveConclusion.length < 200 || val.executiveConclusion.length > 600) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `executiveConclusion must be 200–600 chars, got ${val.executiveConclusion.length}`,
      path: ["executiveConclusion"],
    });
  }
});

export type ExecutiveSummaryStageOutput = z.infer<typeof ExecutiveSummaryStageOutputSchema>;

// ---------- Evidence map artifact ----------

export const ExecutiveSummaryEvidenceMapSchema = z.object({
  schemaVersion: z.literal("executive-summary-evidence-map-v1"),
  caseId: z.string().min(1),
  datasetId: z.string().min(1),
  inputHash: z.string().min(1),
  entries: z.array(
    z.object({
      findingId: z.string().min(1),
      evidenceRefs: z.array(z.string()),
      sourceDomains: z.array(z.string()),
      providers: z.array(z.string()),
      basisKind: BasisKindSchema,
    })
  ),
  excludedAsOtherSubject: z.array(z.string()),
  excludedAsAmbiguous: z.array(z.string()),
});
export type ExecutiveSummaryEvidenceMap = z.infer<typeof ExecutiveSummaryEvidenceMapSchema>;
