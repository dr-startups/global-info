/**
 * Zod schemas for search surface items (Stage H3).
 */

import { z } from "zod";

export const SearchSurfaceTypeSchema = z.enum([
  "ORGANIC_RESULT",
  "SUGGESTION",
  "RELATED_QUERY",
  "IMAGE_RESULT",
  "VIDEO_RESULT",
  "KNOWLEDGE_BLOCK",
  "SERP_SCREENSHOT",
  "MANUAL_NOTE",
  "AI_ANSWER",
]);

export const SearchSurfaceSourceSchema = z.enum([
  "MOCK",
  "REAL_GOOGLE",
  "REAL_YANDEX",
  "REAL_WIKIPEDIA",
  "MANUAL_IMPORT",
  "SYNTHETIC_SNAPSHOT",
]);

const optStr = z.string().trim().min(1).max(2000).optional().nullable();

export const CreateSearchSurfaceItemSchema = z.object({
  type: SearchSurfaceTypeSchema,
  // Manual creates default to MANUAL_IMPORT; agents pass their own source.
  source: SearchSurfaceSourceSchema.default("MANUAL_IMPORT"),
  provider: optStr,
  query: optStr,
  region: z.string().trim().max(64).optional().nullable(),
  language: z.string().trim().max(16).optional().nullable(),
  title: optStr,
  snippet: optStr,
  url: z.string().trim().url().max(2000).optional().nullable(),
  domain: optStr,
  imageUrl: z.string().trim().url().max(2000).optional().nullable(),
  thumbnailUrl: z.string().trim().url().max(2000).optional().nullable(),
  videoUrl: z.string().trim().url().max(2000).optional().nullable(),
  rank: z.number().int().min(0).max(1000).optional().nullable(),
  classification: z.string().trim().max(64).optional().nullable(),
  riskTheme: z.string().trim().max(128).optional().nullable(),
  rawMetadata: z.unknown().optional(),
  demo: z.boolean().optional(),
});

export const BulkCreateSearchSurfaceItemsSchema = z.object({
  items: z.array(CreateSearchSurfaceItemSchema).min(1).max(200),
});

export const ReviewSearchSurfaceItemSchema = z.object({
  reviewStatus: z.enum(["PENDING", "REVIEWED", "DISMISSED"]),
});

export const ListSearchSurfacesQuerySchema = z.object({
  type: SearchSurfaceTypeSchema.optional(),
  source: SearchSurfaceSourceSchema.optional(),
  provider: z.string().trim().max(64).optional(),
});

export type CreateSearchSurfaceItemInput = z.infer<typeof CreateSearchSurfaceItemSchema>;
export type BulkCreateSearchSurfaceItemsInput = z.infer<
  typeof BulkCreateSearchSurfaceItemsSchema
>;
export type ReviewSearchSurfaceItemInput = z.infer<typeof ReviewSearchSurfaceItemSchema>;
