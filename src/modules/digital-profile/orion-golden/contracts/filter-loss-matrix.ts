/**
 * Stage 7 — filter-loss matrix contract (audit artifact).
 */

import { z } from "zod";
import { ContractEnvelopeSchema } from "./common";

export const FILTER_LOSS_MATRIX_SCHEMA_VERSION = "filter-loss-matrix-v1" as const;

export const FilterLossRowSchema = z.object({
  filterId: z.string().min(1),
  stage: z.string().min(1),
  oldBehavior: z.string().min(1),
  falseNegativeScenario: z.string().min(1),
  newBehavior: z.string().min(1),
  reasonCode: z.string().min(1),
  traceArtifact: z.string().min(1),
  kpiImpact: z.string().min(1),
  summaryImpact: z.string().min(1),
  appendixImpact: z.string().min(1),
  /** Count of material false-negatives detected on the audited case/fixture. */
  materialFalseNegatives: z.number().int().min(0),
  status: z.enum(["pass", "fixed", "documented_safe"]),
});
export type FilterLossRow = z.infer<typeof FilterLossRowSchema>;

export const FilterLossMatrixSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(FILTER_LOSS_MATRIX_SCHEMA_VERSION),
  rows: z.array(FilterLossRowSchema).min(1),
  gates: z.object({
    RAW_ACCOUNTING: z.number().min(0).max(100),
    MATERIAL_FILTER_FALSE_NEGATIVES: z.number().int().min(0),
    BASE_LINEAGE_COVERAGE: z.number().min(0).max(100),
    METRIC_CONSISTENCY_PASS: z.boolean(),
  }),
  metrics: z.object({
    rawObservationCount: z.number().int().min(0),
    dispositionEntryCount: z.number().int().min(0),
    otherSubjectInKpi: z.number().int().min(0),
    ambiguousInAppendix: z.number().int().min(0),
    providerErrorLimitations: z.number().int().min(0),
    notCollectedShownAsZeroPercent: z.number().int().min(0),
  }),
});
export type FilterLossMatrix = z.infer<typeof FilterLossMatrixSchema>;
