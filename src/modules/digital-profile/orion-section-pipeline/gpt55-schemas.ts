import { z } from "zod";

export const orionMicrostageAnalysisSchema = z.object({
  microStageKey: z.string().min(1),
  macroSectionKey: z.string().min(1),
  sectionNumber: z.string().nullable(),
  titleRu: z.string().min(1),
  status: z.enum(["ready", "fallback", "unavailable"]),
  generatedBy: z.enum(["gpt-5.5", "deterministic"]),
  clientNarrative: z.object({
    plainConclusion: z.string().min(1),
    whatWasFound: z.array(z.string()),
    whatWasNotConfirmed: z.array(z.string()),
    whatRequiresReview: z.array(z.string()),
    whyItMatters: z.string().min(1),
    recommendedActions: z.array(z.string()),
  }),
  evidenceSummary: z.object({
    total: z.number().int().nonnegative(),
    confirmed: z.number().int().nonnegative(),
    undesirable: z.number().int().nonnegative(),
    potential: z.number().int().nonnegative(),
    requiresReview: z.number().int().nonnegative(),
    excludedNoise: z.number().int().nonnegative(),
    keyDomains: z.array(z.string()),
    keyThemes: z.array(z.string()),
  }),
  slideContent: z.object({
    headline: z.string().min(1),
    subheadline: z.string(),
    metricCards: z.array(z.record(z.unknown())),
    tables: z.array(z.record(z.unknown())),
    narrativeBlocks: z.array(z.record(z.unknown())),
    screenshotRefs: z.array(z.string()),
    visualRefs: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
  }),
  warnings: z.array(z.string()),
});

export type OrionMicrostageAnalysisSchema = z.infer<typeof orionMicrostageAnalysisSchema>;

export function validateOrionMicrostageAnalysis(
  raw: unknown
): { ok: true; value: OrionMicrostageAnalysisSchema } | { ok: false; issues: string[] } {
  const result = orionMicrostageAnalysisSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return {
    ok: false,
    issues: result.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`),
  };
}

