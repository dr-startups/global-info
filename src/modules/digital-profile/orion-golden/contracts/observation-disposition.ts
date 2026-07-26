/**
 * Stage 1 — ObservationDisposition ledger contract.
 * Every raw inventory observation must receive a typed disposition + reason.
 */

import { z } from "zod";
import { ContractEnvelopeSchema, SubjectRelevanceDecisionSchema } from "./common";

export const OBSERVATION_DISPOSITION_LEDGER_SCHEMA_VERSION =
  "observation-disposition-ledger-v1" as const;

export const ObservationDispositionKindSchema = z.enum([
  "KEEP_PRIMARY",
  "KEEP_SUPPORTING",
  "APPENDIX_AMBIGUOUS",
  "EXCLUDE_OTHER_SUBJECT",
  "EXCLUDE_DUPLICATE",
  "EXCLUDE_INVALID",
]);
export type ObservationDispositionKind = z.infer<typeof ObservationDispositionKindSchema>;

export const ObservationDispositionEntrySchema = z.object({
  rawObservationId: z.string().min(1),
  normalizedObservationId: z.string().min(1),
  disposition: ObservationDispositionKindSchema,
  reasonCode: z.string().min(1),
  subjectDecision: SubjectRelevanceDecisionSchema,
  confidence: z.number().min(0).max(1),
  themeCandidates: z.array(z.string()),
  materialitySignals: z.array(z.string()),
  duplicateOf: z.string().nullable(),
  duplicateGroupId: z.string().nullable(),
  evidenceRefs: z.array(z.string()),
  provenance: z.object({
    source: z.string(),
    provider: z.string(),
    reportRunId: z.string(),
    region: z.string(),
    surface: z.string().optional(),
    observationKey: z.string().optional(),
    sourceEvidenceRefs: z.array(z.string()),
  }),
  originalTitle: z.string(),
  originalSnippet: z.string(),
  fullTextRef: z.string().nullable(),
  decidedBy: z.object({
    stage: z.string().min(1),
    functionName: z.string().min(1),
  }),
});
export type ObservationDispositionEntry = z.infer<typeof ObservationDispositionEntrySchema>;

export const ObservationDispositionLedgerSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(OBSERVATION_DISPOSITION_LEDGER_SCHEMA_VERSION),
  inventoryReportRunId: z.string().min(1),
  rawObservationCount: z.number().int().min(0),
  entries: z.array(ObservationDispositionEntrySchema),
  gates: z.object({
    RAW_OBSERVATION_ACCOUNTING: z.number().min(0).max(100),
    UNREASONED_DROPS: z.number().int().min(0),
    P1_P2_SILENT_DROPS: z.number().int().min(0),
    OTHER_SUBJECT_IN_SUBJECT_KPI: z.number().int().min(0),
  }),
});
export type ObservationDispositionLedger = z.infer<typeof ObservationDispositionLedgerSchema>;

export const DISPOSITION_SUMMARY_SCHEMA_VERSION = "disposition-summary-v1" as const;

export const DispositionSummarySchema = z.object({
  schemaVersion: z.literal(DISPOSITION_SUMMARY_SCHEMA_VERSION),
  caseId: z.string().min(1),
  datasetId: z.string().min(1),
  rawObservationCount: z.number().int().min(0),
  byDisposition: z.record(z.number().int().min(0)),
  bySubjectDecision: z.record(z.number().int().min(0)),
  byReasonCode: z.record(z.number().int().min(0)),
  duplicateGroupCount: z.number().int().min(0),
  gates: ObservationDispositionLedgerSchema.shape.gates,
  generatedAt: z.string().min(1),
});
export type DispositionSummary = z.infer<typeof DispositionSummarySchema>;
