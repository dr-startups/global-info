/**
 * Zod validation schemas for manual evidence input (Stage C).
 *
 * Evidence-first: risk findings and database profiles must carry at least one
 * EvidenceRef. Enum values mirror prisma/schema.prisma.
 */

import { z } from "zod";

export const SEARCH_ENGINE_VALUES = [
  "GOOGLE",
  "YANDEX",
  "BING",
  "OTHER",
] as const;

export const QUERY_SOURCE_VALUES = ["MANUAL", "GENERATED"] as const;

export const RESULT_CLASSIFICATION_VALUES = [
  "UNCLASSIFIED",
  "RELEVANT",
  "IRRELEVANT",
  "ADVERSE_MEDIA",
  "SOCIAL_PROFILE",
  "CORPORATE",
  "LEGAL",
  "DUPLICATE",
] as const;

export const REVIEW_STATUS_VALUES = [
  "PENDING",
  "REVIEWED",
  "DISMISSED",
] as const;

export const EVIDENCE_TYPE_VALUES = [
  "URL",
  "SCREENSHOT",
  "IMPORTED_FILE",
  "DATABASE_RECORD",
] as const;

export const RISK_SEVERITY_VALUES = [
  "INFO",
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const;

export const DATABASE_PROVIDER_VALUES = [
  "LEXISNEXIS",
  "DOW_JONES",
  "WORLD_CHECK",
  "OTHER",
] as const;

export const IMPORT_METHOD_VALUES = ["OFFICIAL_API", "MANUAL_IMPORT"] as const;

export const EvidenceRefSchema = z.object({
  type: z.enum(EVIDENCE_TYPE_VALUES),
  refId: z.string().trim().min(1).optional(),
  url: z.string().url().optional(),
  storageKey: z.string().trim().min(1).optional(),
  label: z.string().trim().max(300).optional(),
  capturedAt: z.string().trim().optional(),
});

export const AddSearchQuerySchema = z.object({
  engine: z.enum(SEARCH_ENGINE_VALUES),
  queryText: z.string().trim().min(1).max(500),
  source: z.enum(QUERY_SOURCE_VALUES).default("MANUAL"),
});

export const AddSearchResultSchema = z.object({
  engine: z.enum(SEARCH_ENGINE_VALUES),
  url: z.string().url(),
  title: z.string().trim().max(500).optional(),
  snippet: z.string().trim().max(5000).optional(),
  rank: z.number().int().min(0).max(1000).optional(),
  queryId: z.string().trim().min(1).optional(),
  classification: z.enum(RESULT_CLASSIFICATION_VALUES).optional(),
});

export const ClassifySearchResultSchema = z
  .object({
    classification: z.enum(RESULT_CLASSIFICATION_VALUES).optional(),
    reviewStatus: z.enum(REVIEW_STATUS_VALUES).optional(),
  })
  .refine((d) => d.classification !== undefined || d.reviewStatus !== undefined, {
    message: "Provide classification and/or reviewStatus",
  });

// Stage N1.3 — richer (rawMetadata-backed) manual classification taxonomy.
export const RESULT_CLASS_N13_VALUES = [
  "RELEVANT",
  "NEUTRAL",
  "SOCIAL_PROFILE",
  "CORPORATE",
  "NEWS",
  "ADVERSE_MEDIA",
  "SANCTIONS",
  "PEP",
  "CRIMINAL",
  "LEGAL_DISPUTE",
  "HIGH_RISK",
  "UNKNOWN",
] as const;

export const RESULT_RISK_THEME_VALUES = [
  "sanctions",
  "pep",
  "legal_dispute",
  "adverse_media",
  "criminal",
  "reputation",
  "political_exposure",
  "business_conflict",
  "other",
] as const;

export const ManualResultClassificationSchema = z.object({
  classification: z.enum(RESULT_CLASS_N13_VALUES),
  riskTheme: z.enum(RESULT_RISK_THEME_VALUES).optional(),
  rationale: z.string().trim().max(2000).optional(),
});

export type ManualResultClassificationInput = z.infer<typeof ManualResultClassificationSchema>;

export const AddDatabaseProfileSchema = z.object({
  provider: z.enum(DATABASE_PROVIDER_VALUES),
  importMethod: z.enum(IMPORT_METHOD_VALUES).default("MANUAL_IMPORT"),
  matchType: z.string().trim().max(120).optional(),
  matchScore: z.number().min(0).max(100).optional(),
  rawPayload: z.record(z.string(), z.unknown()).optional(),
  evidenceRefs: z.array(EvidenceRefSchema).min(1, "At least one evidence reference is required"),
});

export const AddWikipediaCheckSchema = z.object({
  exists: z.boolean(),
  url: z.string().url().optional(),
  language: z.string().trim().max(10).default("en"),
  pageTitle: z.string().trim().max(300).optional(),
  snapshot: z.record(z.string(), z.unknown()).optional(),
});

export const AddRiskFindingSchema = z.object({
  category: z.string().trim().min(1).max(120),
  severity: z.enum(RISK_SEVERITY_VALUES).default("INFO"),
  title: z.string().trim().min(1).max(300),
  summary: z.string().trim().max(5000).optional(),
  evidenceRefs: z.array(EvidenceRefSchema).min(1, "At least one evidence reference is required"),
});

export const ReviewRiskFindingSchema = z.object({
  reviewStatus: z.enum(REVIEW_STATUS_VALUES),
  reviewedBy: z.string().trim().max(120).optional(),
});

/** Metadata accompanying a multipart screenshot upload. */
export const ScreenshotUploadMetaSchema = z.object({
  sourceUrl: z.string().url().optional(),
  resultId: z.string().trim().min(1).optional(),
});

export type AddSearchQueryInput = z.infer<typeof AddSearchQuerySchema>;
export type AddSearchResultInput = z.infer<typeof AddSearchResultSchema>;
export type ClassifySearchResultInput = z.infer<typeof ClassifySearchResultSchema>;
export type AddDatabaseProfileInput = z.infer<typeof AddDatabaseProfileSchema>;
export type AddWikipediaCheckInput = z.infer<typeof AddWikipediaCheckSchema>;
export type AddRiskFindingInput = z.infer<typeof AddRiskFindingSchema>;
export type ReviewRiskFindingInput = z.infer<typeof ReviewRiskFindingSchema>;
export type ScreenshotUploadMeta = z.infer<typeof ScreenshotUploadMetaSchema>;
