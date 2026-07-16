import { z } from "zod";
import { ContractEnvelopeSchema, SubjectRelevanceDecisionSchema } from "./common";

export const SUBJECT_RESOLUTION_SCHEMA_VERSION = "subject-resolution-v1" as const;

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
  schemaVersion: z.literal(SUBJECT_RESOLUTION_SCHEMA_VERSION),
  subjectDisplayName: z.string().min(1),
  items: z.array(SubjectResolutionItemSchema),
});

export type SubjectResolution = z.infer<typeof SubjectResolutionSchema>;
export type SubjectResolutionItem = z.infer<typeof SubjectResolutionItemSchema>;
