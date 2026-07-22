/**
 * Stage 5 — composed client summary output (deterministic composer).
 * Not wired to production renderer slides yet.
 */

import { z } from "zod";
import { ContractEnvelopeSchema } from "./common";
import { CanonicalThemeIdSchema, MaterialityLevelSchema } from "./canonical-claim";

export const COMPOSED_CLIENT_SUMMARY_SCHEMA_VERSION = "composed-client-summary-v1" as const;

export const ComposedThemeSectionSchema = z.object({
  themeId: CanonicalThemeIdSchema,
  heading: z.string().min(1),
  body: z.string().min(1),
  materialityLevel: MaterialityLevelSchema,
  evidenceRefs: z.array(z.string()).min(1),
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
  continuationThemeIds: z.array(CanonicalThemeIdSchema),
  gates: z.object({
    SUMMARY_MATERIAL_THEME_COVERAGE: z.number().min(0).max(100),
    SUMMARY_CONCRETE_EXAMPLES_PRESENT: z.boolean(),
    SUMMARY_UNSUPPORTED_ASSERTIONS: z.number().int().min(0),
    SUMMARY_TECHNICAL_COPY_TOKENS: z.number().int().min(0),
    SUMMARY_INCOMPLETE_SENTENCES: z.number().int().min(0),
  }),
});
export type ComposedClientSummary = z.infer<typeof ComposedClientSummarySchema>;
