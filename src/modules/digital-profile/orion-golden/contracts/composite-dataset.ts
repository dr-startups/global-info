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
  /**
   * Текст наблюдения — только там, где страница печатает само наблюдение, а не
   * ссылку на него: нейро-ответ поисковика есть его текст. Для остальных
   * поверхностей текст остаётся в инвентаре: тащить сниппеты всей выдачи в
   * набор значило бы удвоить артефакт ради данных, которые дека не печатает.
   */
  snippet: z.string().optional(),
  domain: z.string().optional(),
  /**
   * Позиция в выдаче, как её сообщил поисковик. Отсутствует у поверхностей без
   * позиций (подсказки, базы) и у старых прогонов — тогда порядок строк
   * остаётся тем, в котором материал собран, а не выдуманным номером.
   */
  rank: z.number().int().positive().optional(),
  /**
   * Чья это позиция — имя провайдера, чью нумерацию несёт `rank`
   * (`yandex` / `serper` / `arsenkin` / `unknown`).
   *
   * Позиция имеет смысл только внутри нумерации одного поисковика: обогатитель
   * идёт поверх чужой выдачи и считает её по-своему. Таблица ТОП-20 печатает
   * позиции только своего движка, и без этого поля отличить их нечем.
   * Необязательное: наборы, снятые до его появления, поля не несут.
   */
  rankSource: z.string().optional(),
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
  /**
   * Запрос строки — само имя субъекта.
   *
   * Все написания ФИО несут один `queryPurpose`, поэтому по назначению они
   * неразличимы; какое из них человек набирает первым, знает только набор
   * запросов. Необязательное: наборы, снятые до появления пометки, её не несут
   * — тогда таблица выбирает запрос запасным правилом и говорит об этом.
   */
  subjectNameQuery: z.boolean().optional(),
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
