import { z } from "zod";
import { ContractEnvelopeSchema, SubjectRelevanceDecisionSchema } from "./common";

/** Current write version (§2.1 — LIKELY_SUBJECT). */
export const SUBJECT_RESOLUTION_SCHEMA_VERSION = "subject-resolution-v2" as const;
/** Read compat: accept pre-2.1 artifacts. */
export const SUBJECT_RESOLUTION_SCHEMA_VERSIONS = [
  "subject-resolution-v1",
  "subject-resolution-v2",
] as const;

export const SubjectResolutionItemSchema = z.object({
  evidenceRef: z.string().min(1),
  decision: SubjectRelevanceDecisionSchema,
  confidence: z.number().min(0).max(1),
  matchedIdentifiers: z.array(z.string()),
  conflictingIdentifiers: z.array(z.string()),
  reasonCode: z.string().min(1),
  /** Legacy enum notes only — Stage 1 does not rewrite WRONG_SUBJECT production paths. */
  legacyBindingNote: z.string().optional(),
});

export const SubjectResolutionSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.enum(SUBJECT_RESOLUTION_SCHEMA_VERSIONS),
  subjectDisplayName: z.string().min(1),
  items: z.array(SubjectResolutionItemSchema),
});

export type SubjectResolution = z.infer<typeof SubjectResolutionSchema>;
export type SubjectResolutionItem = z.infer<typeof SubjectResolutionItemSchema>;
