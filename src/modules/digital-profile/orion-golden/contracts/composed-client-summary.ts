/**
 * Stage 5 — composed client summary output (deterministic composer).
 *
 * This artifact reaches the client: the deck loads
 * `composed-client-summary.json` (`load-deck-inputs`), paginates it
 * semantically and prints it as the executive summary slides. Frozen v1 runs
 * are read as-is, without schema validation, and keep working.
 */

import { z } from "zod";
import { ContractEnvelopeSchema } from "./common";
import { MaterialityLevelSchema } from "./canonical-claim";

export const COMPOSED_CLIENT_SUMMARY_SCHEMA_VERSION = "composed-client-summary-v2" as const;

export const ComposedThemeSectionSchema = z.object({
  /**
   * Тема словаря (`criminal_judicial`) или сюжет прочитанных страниц
   * (`plot:<хэш названия>`): у сюжета канонической темы нет и быть не может.
   */
  themeId: z.string().min(1),
  /** Из какого мира блок: претензии выдачи или сюжет прочитанных страниц. */
  kind: z.enum(["claims", "read_plot"]).default("claims"),
  heading: z.string().min(1),
  body: z.string().min(1),
  /** Степень существенности — понятие мира претензий; сюжету её не выдумывают. */
  materialityLevel: MaterialityLevelSchema.optional(),
  /**
   * Пустой список схема пропускает намеренно: блок без оснований ловят ворота
   * `SUMMARY_UNSUPPORTED_ASSERTIONS` — с именем и числом, а не отказом разбора.
   */
  evidenceRefs: z.array(z.string()),
  articleTitles: z.array(z.string()),
  articleDomains: z.array(z.string()),
});
export type ComposedThemeSection = z.infer<typeof ComposedThemeSectionSchema>;

export const ComposedClientSummarySchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(COMPOSED_CLIENT_SUMMARY_SCHEMA_VERSION),
  subjectId: z.string().min(1),
  /** Full client-readable summary (may include continuation marker). */
  fullText: z.string().min(1),
  /** Semantic blocks for pagination (Stage 6). */
  sections: z.object({
    scope: z.string().min(1),
    overallAssessment: z.string().min(1),
    auditShortHeading: z.literal("Коротко по итогам аудита"),
    themes: z.array(ComposedThemeSectionSchema),
    isolatedItems: z.string(),
    internationalDatabases: z.string(),
    changesSinceBaseline: z.string(),
    nextSteps: z.string().min(1),
  }),
  /** Themes that did not fit the lead block — still fully written, not shortened. */
  continuationThemeIds: z.array(z.string()),
  gates: z.object({
    SUMMARY_MATERIAL_THEME_COVERAGE: z.number().min(0).max(100),
    SUMMARY_CONCRETE_EXAMPLES_PRESENT: z.boolean(),
    SUMMARY_UNSUPPORTED_ASSERTIONS: z.number().int().min(0),
    SUMMARY_TECHNICAL_COPY_TOKENS: z.number().int().min(0),
    SUMMARY_INCOMPLETE_SENTENCES: z.number().int().min(0),
  }),
});
export type ComposedClientSummary = z.infer<typeof ComposedClientSummarySchema>;
