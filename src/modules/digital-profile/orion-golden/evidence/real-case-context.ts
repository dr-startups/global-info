/**
 * Shared real-case context types used by golden/canonical asset builders.
 * Extracted from legacy `orion-section-pipeline/real-case-data-adapter` (9.3).
 */

import type { Prisma } from "@prisma/client";
import type { ReportJson } from "../../types";

export type OrionSearchResultRow = {
  id: string;
  engine: string;
  source: string | null;
  url: string;
  title: string | null;
  snippet: string | null;
  rank: number | null;
  classification: string;
  reviewStatus: string;
  rawMetadata: Prisma.JsonValue | null;
};

export type OrionSearchSurfaceRow = {
  id: string;
  type: string;
  provider: string | null;
  source: string;
  region: string | null;
  language: string | null;
  query: string | null;
  title: string | null;
  snippet: string | null;
  url: string | null;
  domain: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  rank: number | null;
  classification: string | null;
  riskTheme: string | null;
  reviewStatus: string;
  rawMetadata: Prisma.JsonValue | null;
};

export type OrionDbProfileRow = {
  id: string;
  provider: string;
  importMethod: string;
  hitSource: string | null;
  matchedName: string | null;
  matchType: string | null;
  matchScore: number | null;
  reviewStatus: string;
  riskTypes: Prisma.JsonValue;
  summary: string | null;
  rawMetadataSafe: Prisma.JsonValue | null;
  profileUrl: string | null;
  evidenceRefs: Prisma.JsonValue;
  importedAt: Date;
};

export type OrionRiskFindingRow = {
  id: string;
  category: string;
  severity: string;
  title: string;
  summary: string | null;
  reviewStatus: string;
  evidenceRefs: Prisma.JsonValue;
};

export type OrionWikiRow = {
  exists: boolean;
  url: string | null;
  language: string | null;
  pageTitle: string | null;
};

export type OrionCaseScreenshotRow = {
  id: string;
  storageKey: string;
  mimeType: string;
  sourceUrl: string | null;
  resultId: string | null;
  capturedAt: Date;
  sizeBytes: number | null;
};

export interface OrionRealCaseContext {
  caseId: string;
  locale: "ru" | "en";
  subject: {
    fullName: string;
    aliases: string[];
  };
  targetRegions: string[];
  reportJson: ReportJson;
  searchResults: OrionSearchResultRow[];
  searchSurfaces: OrionSearchSurfaceRow[];
  databaseProfiles: OrionDbProfileRow[];
  riskFindings: OrionRiskFindingRow[];
  wikiChecks: OrionWikiRow[];
  /** Captured / persisted SERP screenshots (private storage keys). */
  screenshots: OrionCaseScreenshotRow[];
  providerAvailability: {
    used: string[];
    unavailable: string[];
  };
  lexis: {
    latestReady: Record<string, unknown> | null;
    latestAny: Record<string, unknown> | null;
    visualPageCount: number;
    parsedSignals: number;
    uploadExists: boolean;
  };
}
