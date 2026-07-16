import { z } from "zod";
import { ContractEnvelopeSchema, RiskLevelSchema } from "./common";

export const EXECUTIVE_SUMMARY_SCHEMA_VERSION = "executive-summary-v1" as const;

export const ExecutiveSummarySchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(EXECUTIVE_SUMMARY_SCHEMA_VERSION),
  headline: z.string().min(1),
  summaryParagraphs: z.array(z.string()),
  keyFindingIds: z.array(z.string()),
  overallRiskLevel: RiskLevelSchema,
  limitations: z.array(z.string()),
  recommendedNextSteps: z.array(z.string()),
});

export type ExecutiveSummary = z.infer<typeof ExecutiveSummarySchema>;
