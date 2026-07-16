import { z } from "zod";
import {
  ContractEnvelopeSchema,
  RiskLevelSchema,
  SubjectRelevanceDecisionSchema,
} from "./common";

export const FINDING_SCHEMA_VERSION = "finding-v1" as const;

export const PromotionPrioritySchema = z.enum(["P1", "P2", "P3", "APPENDIX"]);
export type PromotionPriority = z.infer<typeof PromotionPrioritySchema>;

export const FindingContradictionSchema = z.object({
  description: z.string().min(1),
  withFindingId: z.string().optional(),
  evidenceRefs: z.array(z.string()),
});
export type FindingContradiction = z.infer<typeof FindingContradictionSchema>;

export const FindingSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(FINDING_SCHEMA_VERSION),
  findingId: z.string().min(1),
  theme: z.string().min(1),
  claim: z.string().min(1),
  subjectMatch: SubjectRelevanceDecisionSchema,
  riskLevel: RiskLevelSchema,
  confidence: z.number().min(0).max(1),
  regions: z.array(z.string()),
  sourceDomains: z.array(z.string()),
  providers: z.array(z.string()),
  recommendedAction: z.string().min(1),
  contradictions: z.array(FindingContradictionSchema),
  limitations: z.array(z.string()),
  promotionPriority: PromotionPrioritySchema,
  surfaceKinds: z.array(z.string()).optional(),
});

export type Finding = z.infer<typeof FindingSchema>;
