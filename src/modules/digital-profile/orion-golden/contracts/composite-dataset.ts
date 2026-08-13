import { z } from "zod";
import { ContractEnvelopeSchema } from "./common";

export const COMPOSITE_DATASET_SCHEMA_VERSION = "composite-dataset-v1" as const;

export const CompositeObservationRowSchema = z.object({
  observationKey: z.string().min(1),
  provider: z.string().min(1),
  providers: z.array(z.string()).min(1),
  engine: z.string().min(1),
  surface: z.string().min(1),
  region: z.string().min(1),
  url: z.string().optional(),
  title: z.string().optional(),
  domain: z.string().optional(),
  /**
   * Позиция в выдаче, как её сообщил поисковик. Отсутствует у поверхностей без
   * позиций (подсказки, базы) и у старых прогонов — тогда порядок строк
   * остаётся тем, в котором материал собран, а не выдуманным номером.
   */
  rank: z.number().int().positive().optional(),
  /**
   * Текст запроса, по которому материал показался.
   *
   * Позиция без запроса ничего не значит: «третья строка» — третья по какому
   * запросу? Отчёт обещает аудит выдачи по названному набору запросов, и
   * таблица позиций строится по разрезу «запрос × поисковик».
   */
  query: z.string().optional(),
  /** Назначение запроса из плана — отличает выдачу по имени от целевой пробы. */
  queryPurpose: z.string().optional(),
  evidenceRefs: z.array(z.string()),
  provenanceOwner: z.enum(["base", "enrichment", "legacy"]),
});

export const CompositeDatasetSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(COMPOSITE_DATASET_SCHEMA_VERSION),
  baseReportRunId: z.string().nullable(),
  enrichmentRunIds: z.array(z.string()),
  baseCount: z.number().int().nonnegative(),
  enrichmentCount: z.number().int().nonnegative(),
  compositeCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  observations: z.array(CompositeObservationRowSchema),
});

export type CompositeDataset = z.infer<typeof CompositeDatasetSchema>;
export type CompositeObservationRow = z.infer<typeof CompositeObservationRowSchema>;
