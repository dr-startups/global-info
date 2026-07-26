import { z } from "zod";

const itemStatusSchema = z.enum([
  "confirmed",
  "requires_review",
  "excluded_noise",
  "not_confirmed",
]);

const themeSummarySchema = z.object({
  label: z.string().min(1).max(180),
  explanation: z.string().min(1).max(600),
  evidenceCount: z.number().int().min(0).max(100000),
  status: itemStatusSchema,
});

const domainSummarySchema = z.object({
  domain: z.string().min(1).max(180),
  label: z.string().min(1).max(180),
  explanation: z.string().min(1).max(600),
  evidenceCount: z.number().int().min(0).max(100000),
  status: itemStatusSchema,
});

const regionNarrativeSchema = z.object({
  confirmedNegativeSummary: z.string().min(1).max(1200),
  potentialNegativeSummary: z.string().min(1).max(1200),
  reviewRequiredSummary: z.string().min(1).max(1200),
  topThemes: z.array(themeSummarySchema).max(10),
  keyDomains: z.array(domainSummarySchema).max(10),
  riskExplanation: z.string().min(1).max(1500),
  recommendedActions: z.array(z.string().min(1).max(300)).max(8),
  sanctionsWatchlistContext: z.string().min(1).max(1200).optional(),
});

const lexisNexisNarrativeSchema = z.object({
  importStatus: z.string().min(1).max(200),
  screeningConclusion: z.string().min(1).max(1200),
  matchesSummary: z.string().min(1).max(1200),
  reviewRequiredSummary: z.string().min(1).max(1200),
  visualPagesSummary: z.string().min(1).max(1200),
});

const evidenceInterpretationSchema = z.object({
  confirmed: z.string().min(1).max(1200),
  reviewRequired: z.string().min(1).max(1200),
  excludedNoise: z.string().min(1).max(1200),
  confidence: z.string().min(1).max(1200),
});

export const aiAnalystNarrativeSchema = z.object({
  status: z.enum(["ready", "fallback", "unavailable"]),
  generatedBy: z.enum(["gpt-5.5", "deterministic"]),
  provider: z.enum(["openai", "none"]),
  language: z.enum(["ru", "en"]),
  generatedAt: z.string().datetime().optional(),
  meta: z.object({
    evidenceItemsUsed: z.number().int().min(0).max(100000),
    truncatedInput: z.boolean(),
    warnings: z.array(z.string().max(300)).max(20),
  }),
  executiveSummary: z.object({
    plainConclusion: z.string().min(1).max(1500),
    riskExplanation: z.string().min(1).max(1500),
    whyNotLow: z.string().min(1).max(1500),
    whatWasFound: z.array(z.string().min(1).max(300)).max(10),
    whatWasNotConfirmed: z.array(z.string().min(1).max(300)).max(10),
    manualReviewRequired: z.array(z.string().min(1).max(300)).max(10),
    nextActions: z.array(z.string().min(1).max(300)).max(10),
  }),
  regionNarratives: z.object({
    ru: regionNarrativeSchema.optional(),
    intl: regionNarrativeSchema.optional(),
  }),
  lexisNexisNarrative: lexisNexisNarrativeSchema.optional(),
  evidenceInterpretation: evidenceInterpretationSchema,
  clientSafeWarnings: z.array(z.string().max(300)).max(20),
});

export type AiAnalystNarrativeSchema = z.infer<typeof aiAnalystNarrativeSchema>;

export function validateAiAnalystNarrative(
  raw: unknown
): { ok: true; value: AiAnalystNarrativeSchema } | { ok: false; issues: string[] } {
  const parsed = aiAnalystNarrativeSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    issues: parsed.error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`),
  };
}
