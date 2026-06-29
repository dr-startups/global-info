/**
 * Evidence loader for the Risk Classifier v1 (Stage I).
 *
 * Loads only live (non-deleted) evidence for a case. Existing risk findings are
 * returned too so the classifier can stay idempotent and respect human review
 * decisions (REVIEWED/DISMISSED are never overwritten).
 */

import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../http/errors";

export interface LoadedSearchResult {
  id: string;
  engine: string;
  url: string;
  title: string | null;
  snippet: string | null;
  classification: string;
  source: string | null;
}

export interface LoadedSurfaceItem {
  id: string;
  type: string;
  source: string;
  provider: string | null;
  query: string | null;
  title: string | null;
  snippet: string | null;
  url: string | null;
  classification: string | null;
  rawMetadata: unknown;
}

export interface LoadedWikipediaCheck {
  id: string;
  exists: boolean;
  url: string | null;
  language: string | null;
  pageTitle: string | null;
  snapshot: unknown;
  checkedBy: string | null;
}

export interface LoadedDatabaseProfile {
  id: string;
  provider: string;
  matchType: string | null;
  matchScore: number | null;
  reviewStatus?: string;
  riskTypes?: string[];
}

export interface LoadedExistingFinding {
  id: string;
  dedupHash: string | null;
  reviewStatus: string;
  severity: string;
  createdBy: string | null;
}

export interface LoadedCaseEvidence {
  subject: { fullName: string; aliases: string[] };
  searchResults: LoadedSearchResult[];
  searchSurfaceItems: LoadedSurfaceItem[];
  wikipediaChecks: LoadedWikipediaCheck[];
  databaseProfiles: LoadedDatabaseProfile[];
  existingRiskFindings: LoadedExistingFinding[];
}

export async function loadCaseEvidence(caseId: string): Promise<LoadedCaseEvidence> {
  const caseRow = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: {
      id: true,
      subjects: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { fullName: true, aliases: true },
      },
    },
  });
  if (!caseRow) throw new NotFoundError("Case not found");

  const [searchResults, searchSurfaceItems, wikipediaChecks, databaseProfiles, existingRiskFindings] =
    await Promise.all([
      prisma.searchResult.findMany({
        where: { caseId },
        select: {
          id: true,
          engine: true,
          url: true,
          title: true,
          snippet: true,
          classification: true,
          source: true,
        },
      }),
      prisma.searchSurfaceItem.findMany({
        where: { caseId, deletedAt: null },
        select: {
          id: true,
          type: true,
          source: true,
          provider: true,
          query: true,
          title: true,
          snippet: true,
          url: true,
          classification: true,
          rawMetadata: true,
        },
      }),
      prisma.wikipediaCheck.findMany({
        where: { caseId },
        select: {
          id: true,
          exists: true,
          url: true,
          language: true,
          pageTitle: true,
          snapshot: true,
          checkedBy: true,
        },
      }),
      prisma.databaseProfile.findMany({
        where: { caseId },
        select: {
          id: true,
          provider: true,
          matchType: true,
          matchScore: true,
          reviewStatus: true,
          riskTypes: true,
        },
      }),
      prisma.riskFinding.findMany({
        where: { caseId },
        select: {
          id: true,
          dedupHash: true,
          reviewStatus: true,
          severity: true,
          createdBy: true,
        },
      }),
    ]);

  const subject = caseRow.subjects[0] ?? { fullName: "Unknown Subject", aliases: [] };

  return {
    subject: { fullName: subject.fullName, aliases: subject.aliases },
    searchResults,
    searchSurfaceItems,
    wikipediaChecks,
    databaseProfiles: databaseProfiles.map((d) => ({
      ...d,
      riskTypes: Array.isArray(d.riskTypes) ? (d.riskTypes as string[]) : [],
    })),
    existingRiskFindings,
  };
}
