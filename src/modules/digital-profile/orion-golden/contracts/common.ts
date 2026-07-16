/**
 * Stage 1 — shared contract envelope fields.
 * Unwired: types/validators only; not imported into ThemeSet/composer/render for behavior.
 */

import { z } from "zod";

export const ContractEnvelopeSchema = z.object({
  schemaVersion: z.string().min(1),
  caseId: z.string().min(1),
  datasetId: z.string().min(1),
  sourceHashes: z.array(z.string()).min(0),
  evidenceRefs: z.array(z.string()).min(0),
});

export type ContractEnvelope = z.infer<typeof ContractEnvelopeSchema>;

export type SubjectRelevanceDecision =
  | "SUBJECT_MATCH"
  | "AMBIGUOUS"
  | "OTHER_SUBJECT"
  | "INSUFFICIENT_IDENTIFIERS";

export const SubjectRelevanceDecisionSchema = z.enum([
  "SUBJECT_MATCH",
  "AMBIGUOUS",
  "OTHER_SUBJECT",
  "INSUFFICIENT_IDENTIFIERS",
]);

export type SampleStatus = "MEASURED" | "NOT_COLLECTED" | "NOT_APPLICABLE";

export const SampleStatusSchema = z.enum(["MEASURED", "NOT_COLLECTED", "NOT_APPLICABLE"]);

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export const RiskLevelSchema = z.enum(["none", "low", "medium", "high", "critical"]);

export type SurfaceKind =
  | "organic"
  | "suggestions"
  | "images"
  | "wikipedia"
  | "ai_answers"
  | "paa_related"
  | "url_audit"
  | "compliance";

export const SurfaceKindSchema = z.enum([
  "organic",
  "suggestions",
  "images",
  "wikipedia",
  "ai_answers",
  "paa_related",
  "url_audit",
  "compliance",
]);
