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
  /**
   * Which of `evidenceRefs` are «nothing found» markers rather than collected
   * rows — the named counterpart of the `emptyMarkerCount` metric.
   *
   * Признак маркера выводится по заголовку **и сниппету** записи инвентаря, а
   * сниппета в индексе доказательств нет: на прогоне 72 маркер называется
   * «Wikipedia» и от материала по заголовку неотличим. Пока потребители
   * выводили признак сами, страница ОАЭ печатала маркеры как энциклопедические
   * материалы. Ответ даёт тот, у кого есть данные, — анализатор.
   *
   * Необязательно: артефакты прогонов, снятые до появления поля, его не несут,
   * и тогда потребитель не знает ответа — но и не выдумывает его.
   */
  emptyMarkerRefs: z.array(z.string()).optional(),
});

export const SurfaceAnalysisSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.enum(SURFACE_ANALYSIS_SCHEMA_VERSIONS),
  units: z.array(SurfaceAnalysisUnitSchema),
});

export type SurfaceAnalysis = z.infer<typeof SurfaceAnalysisSchema>;
export type SurfaceAnalysisUnit = z.infer<typeof SurfaceAnalysisUnitSchema>;
export type SurfaceClaim = z.infer<typeof SurfaceClaimSchema>;
