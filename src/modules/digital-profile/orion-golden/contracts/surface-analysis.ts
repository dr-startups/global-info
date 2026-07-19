import { z } from "zod";
import {
  ContractEnvelopeSchema,
  SampleStatusSchema,
  SubjectRelevanceDecisionSchema,
  SurfaceKindSchema,
} from "./common";

export const SURFACE_ANALYSIS_SCHEMA_VERSION = "surface-analysis-v2" as const;
export const SURFACE_ANALYSIS_SCHEMA_VERSIONS = [
  "surface-analysis-v1",
  "surface-analysis-v2",
] as const;

export const SurfaceMetricSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.number(), z.string(), z.boolean()]),
  sampleStatus: SampleStatusSchema,
  denominator: z.number().optional(),
});

export const SurfaceClaimSchema = z.object({
  claimId: z.string().min(1),
  text: z.string().min(1),
  subjectMatch: SubjectRelevanceDecisionSchema,
  evidenceRefs: z.array(z.string()),
  riskHint: z.string().optional(),
});

export const SurfaceAnalysisUnitSchema = z.object({
  surface: SurfaceKindSchema,
  region: z.string().min(1),
  engine: z.string().optional(),
  metrics: z.array(SurfaceMetricSchema),
  claims: z.array(SurfaceClaimSchema),
  evidenceRefs: z.array(z.string()),
});

export const SurfaceAnalysisSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.enum(SURFACE_ANALYSIS_SCHEMA_VERSIONS),
  units: z.array(SurfaceAnalysisUnitSchema),
});

export type SurfaceAnalysis = z.infer<typeof SurfaceAnalysisSchema>;
export type SurfaceAnalysisUnit = z.infer<typeof SurfaceAnalysisUnitSchema>;
export type SurfaceClaim = z.infer<typeof SurfaceClaimSchema>;
