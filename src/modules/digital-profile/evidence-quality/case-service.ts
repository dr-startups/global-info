/**
 * Stage O5 — loads case evidence and runs quality gate.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { buildEvidenceQualitySummary, gateItemsForReport } from "./build-summary";
import type { EvidenceItemInput, EvidenceQualitySummary, EvidenceSurfaceType } from "./types";
import { selectEvidenceForReport } from "./selection-policy";
import { mergeEvidenceQualityMetadata } from "./gate";

const SURFACE_TYPE_MAP: Record<string, EvidenceSurfaceType> = {
  SUGGESTION: "SEARCH_SUGGESTION",
  RELATED_QUERY: "RELATED_QUERY",
  IMAGE_RESULT: "IMAGE_RESULT",
  VIDEO_RESULT: "VIDEO_RESULT",
  KNOWLEDGE_BLOCK: "KNOWLEDGE_BLOCK",
};

export async function loadCaseEvidenceItems(caseId: string): Promise<{
  items: EvidenceItemInput[];
  subjectFullName: string | null;
}> {
  const [subjectRow, organic, surfaces] = await Promise.all([
    prisma.case.findFirst({
      where: { id: caseId },
      select: {
        targetRegions: true,
        subjects: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: {
            fullName: true,
            aliases: true,
            country: true,
            nationality: true,
          },
        },
      },
    }),
    prisma.searchResult.findMany({
      where: { caseId },
      select: {
        id: true,
        title: true,
        url: true,
        snippet: true,
        classification: true,
        reviewStatus: true,
        source: true,
        rawMetadata: true,
        engine: true,
      },
    }),
    prisma.searchSurfaceItem.findMany({
      where: { caseId, deletedAt: null, demo: false, type: { not: "MANUAL_NOTE" } },
      select: {
        id: true,
        type: true,
        region: true,
        title: true,
        snippet: true,
        url: true,
        domain: true,
        thumbnailUrl: true,
        classification: true,
        riskTheme: true,
        query: true,
        reviewStatus: true,
        source: true,
        rawMetadata: true,
      },
    }),
  ]);

  const subject = subjectRow?.subjects[0];
  const subjectFullName = subject?.fullName ?? null;
  const subjectAliases = (subject?.aliases ?? []).filter(Boolean);
  const subjectCountry = subject?.country ?? null;
  const subjectNationality = subject?.nationality ?? null;
  const subjectRegionHints = (subjectRow?.targetRegions ?? []).filter(Boolean);
  const items: EvidenceItemInput[] = [];

  for (const r of organic) {
    items.push({
      id: r.id,
      surfaceType: "SEARCH_RESULT",
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      classification: r.classification,
      reviewStatus: r.reviewStatus,
      source: r.source,
      rawMetadata: r.rawMetadata,
      subjectFullName,
      subjectAliases,
      subjectCountry,
      subjectNationality,
      subjectRegionHints,
    });
  }

  for (const s of surfaces) {
    const surfaceType = SURFACE_TYPE_MAP[s.type] ?? "SEARCH_SUGGESTION";
    items.push({
      id: s.id,
      surfaceType,
      title: s.title,
      url: s.url,
      domain: s.domain,
      snippet: s.snippet,
      thumbnailUrl: s.thumbnailUrl,
      classification: s.classification,
      riskTheme: s.riskTheme,
      query: s.query,
      region: s.region,
      reviewStatus: s.reviewStatus,
      source: s.source,
      rawMetadata: s.rawMetadata,
      subjectFullName,
      subjectAliases,
      subjectCountry,
      subjectNationality,
      subjectRegionHints,
    });
  }

  return { items, subjectFullName };
}

export async function buildCaseEvidenceQuality(caseId: string): Promise<EvidenceQualitySummary> {
  const { items, subjectFullName } = await loadCaseEvidenceItems(caseId);
  return buildEvidenceQualitySummary(items, subjectFullName);
}

export async function getCaseReviewQueue(caseId: string) {
  const { items, subjectFullName } = await loadCaseEvidenceItems(caseId);
  const gated = gateItemsForReport(items, subjectFullName);
  const internal = selectEvidenceForReport(gated, "INTERNAL");
  return {
    summary: buildEvidenceQualitySummary(items, subjectFullName),
    items: gated.slice(0, 500).map((item) => ({
      id: item.id,
      title: item.title ?? item.query ?? "",
      surfaceType: item.surfaceType,
      region: item.region,
      thumbnailUrl: item.thumbnailUrl,
      quality: item.quality,
    })),
    reviewRequired: internal.reviewRequired,
    selected: internal.selected.slice(0, 100),
    excluded: internal.excluded.slice(0, 50),
  };
}

export async function setSurfaceReportEligibility(
  surfaceId: string,
  eligibility: "CLIENT_INCLUDE" | "INTERNAL_ONLY" | "REVIEW_REQUIRED" | "EXCLUDE"
): Promise<void> {
  const row = await prisma.searchSurfaceItem.findUnique({
    where: { id: surfaceId },
    select: { rawMetadata: true },
  });
  if (!row) throw new Error("Surface not found");
  const base =
    row.rawMetadata && typeof row.rawMetadata === "object"
      ? { ...(row.rawMetadata as Record<string, unknown>) }
      : {};
  const eq = (base.evidenceQuality as Record<string, unknown>) ?? {};
  base.evidenceQuality = { ...eq, reportEligibilityOverride: eligibility };
  await prisma.searchSurfaceItem.update({
    where: { id: surfaceId },
    data: {
      rawMetadata: base as Prisma.InputJsonValue,
      reviewStatus: eligibility === "EXCLUDE" ? "DISMISSED" : "REVIEWED",
    },
  });
}

export async function persistEvidenceQualityOnResults(caseId: string): Promise<number> {
  const { items, subjectFullName } = await loadCaseEvidenceItems(caseId);
  const gated = gateItemsForReport(items, subjectFullName);
  let updated = 0;
  for (const item of gated) {
    if (item.surfaceType !== "SEARCH_RESULT" || !item.id) continue;
    const next = mergeEvidenceQualityMetadata(item.rawMetadata, item.quality);
    await prisma.searchResult.update({
      where: { id: item.id },
      data: { rawMetadata: next as Prisma.InputJsonValue },
    });
    updated += 1;
  }
  return updated;
}
