/**
 * R10 — Full evidence inventory (no early slicing).
 */

import type { OrionRealCaseContext } from "./real-case-context";
import type { RawInventoryItem } from "../types";
import {
  countSearchSurfaceMediaAvailability,
  resolveSearchSurfaceMediaCategory,
} from "./search-surface-media";

export interface FullEvidenceInventory {
  version: "r10-full-evidence-inventory-v1";
  caseId: string;
  reportRunId: string;
  inspectedAt: string;
  subject: { fullName: string; aliases: string[] };
  counts: {
    searchResults: number;
    searchSurfaces: number;
    databaseProfiles: number;
    riskFindings: number;
    wikiChecks: number;
    screenshots: number;
  };
  countsBySource: Record<string, number>;
  countsByRegion: Record<string, number>;
  countsByEvidenceType: Record<string, number>;
  mediaAvailability: {
    images: number;
    videos: number;
    knowledgePanels: number;
    serpScreenshots: number;
    suggestions: number;
    relatedQueries: number;
    manualNotes: number;
    organicResults: number;
  };
  lexisNexis: {
    uploadExists: boolean;
    latestReady: boolean;
    visualPageCount: number;
    parsedSignals: number;
    status: string;
  };
  missingSources: string[];
  warnings: string[];
  items: RawInventoryItem[];
}

function asObj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

function regionOf(raw: Record<string, unknown>, fallback = ""): string {
  const r = String(raw.orionRegion ?? raw.region ?? fallback).toUpperCase();
  return r || fallback;
}

export function buildFullEvidenceInventory(input: {
  caseId: string;
  reportRunId: string;
  ctx: OrionRealCaseContext;
}): FullEvidenceInventory {
  const { caseId, reportRunId, ctx } = input;
  const now = new Date().toISOString();
  const items: RawInventoryItem[] = [];
  const countsBySource: Record<string, number> = {};
  const countsByRegion: Record<string, number> = {};
  const countsByEvidenceType: Record<string, number> = {};
  const warnings: string[] = [];
  const missingSources: string[] = [];

  const bump = (map: Record<string, number>, key: string) => {
    map[key] = (map[key] ?? 0) + 1;
  };

  for (const row of ctx.searchResults) {
    const rm = asObj(row.rawMetadata);
    const provider = String(row.source ?? row.engine ?? "search").toUpperCase();
    const reg = regionOf(rm);
    const id = `sr-${row.id}`;
    items.push({
      inventoryId: id,
      caseId,
      reportRunId,
      source: "search_result",
      provider,
      region: reg,
      query: String(rm.query ?? rm.orionQuery ?? ""),
      collectedAt: now,
      evidenceType: "search_result",
      title: String(row.title ?? "").trim() || String(row.url ?? "Результат поиска"),
      snippet: String(row.snippet ?? ""),
      sourceUrl: row.url,
      classification: row.classification,
      rawMetadata: rm,
    });
    bump(countsBySource, provider);
    bump(countsByRegion, reg);
    bump(countsByEvidenceType, "search_result");
  }

  for (const row of ctx.searchSurfaces) {
    const mediaCategory = resolveSearchSurfaceMediaCategory(row);
    const type = mediaCategory;
    const provider = String(row.provider ?? row.source ?? "surface").toUpperCase();
    const reg = String(row.region ?? "RU").toUpperCase();
    const id = `ss-${row.id}`;
    items.push({
      inventoryId: id,
      caseId,
      reportRunId,
      source: "search_surface",
      provider,
      region: reg,
      query: row.query ?? undefined,
      collectedAt: now,
      evidenceType: type.toLowerCase(),
      title: String(row.title ?? "").trim() || type,
      snippet: String(row.snippet ?? ""),
      sourceUrl: row.url ?? undefined,
      imageUrl: row.imageUrl ?? row.thumbnailUrl ?? undefined,
      videoUrl: row.videoUrl ?? undefined,
      classification: row.classification ?? undefined,
      rawMetadata: asObj(row.rawMetadata),
    });
    bump(countsBySource, provider);
    bump(countsByRegion, reg);
    bump(countsByEvidenceType, type);
  }

  for (const row of ctx.databaseProfiles) {
    const provider = String(row.provider ?? "COMPLIANCE").toUpperCase();
    const safeMeta = asObj(row.rawMetadataSafe);
    const riskTypes = Array.isArray(row.riskTypes) ? row.riskTypes.map((x) => String(x)) : [];
    const evidenceRefs = Array.isArray(row.evidenceRefs) ? row.evidenceRefs : [];
    const profileUrl = String(row.profileUrl ?? "").trim();
    const firstRefUrl = evidenceRefs
      .map((r) => {
        if (!r || typeof r !== "object" || Array.isArray(r)) return "";
        return String((r as Record<string, unknown>).url ?? "").trim();
      })
      .find((u) => /^https?:\/\//i.test(u));
    items.push({
      inventoryId: `db-${row.id}`,
      caseId,
      reportRunId,
      source: "database_profile",
      provider,
      region: "GLOBAL",
      collectedAt: now,
      evidenceType: "compliance_hit",
      title: String(row.matchedName ?? row.summary ?? provider),
      snippet: String(row.summary ?? ""),
      sourceUrl: profileUrl || firstRefUrl || undefined,
      classification: String(row.reviewStatus ?? ""),
      // Preserve structured DB columns — classic ThemeSet needs them for RCA/PEP cards.
      rawMetadata: {
        ...safeMeta,
        riskTypes,
        matchType: row.matchType ?? undefined,
        matchScore: row.matchScore ?? undefined,
        reviewStatus: row.reviewStatus,
        importMethod: row.importMethod,
        hitSource: row.hitSource ?? undefined,
        matchedName: row.matchedName ?? undefined,
        profileUrl: profileUrl || undefined,
        evidenceRefs,
      },
    });
    bump(countsBySource, provider);
    bump(countsByEvidenceType, "compliance_hit");
  }

  for (const row of ctx.riskFindings) {
    items.push({
      inventoryId: `rf-${row.id}`,
      caseId,
      reportRunId,
      source: "risk_finding",
      provider: "INTERNAL",
      region: "GLOBAL",
      collectedAt: now,
      evidenceType: "risk_finding",
      title: row.title,
      snippet: String(row.summary ?? ""),
      classification: row.category,
    });
    bump(countsByEvidenceType, "risk_finding");
  }

  for (const [idx, row] of ctx.wikiChecks.entries()) {
    items.push({
      inventoryId: `wiki-${idx + 1}`,
      caseId,
      reportRunId,
      source: "wikipedia",
      provider: "WIKIPEDIA",
      region: String(row.language ?? "ru").toUpperCase(),
      collectedAt: now,
      evidenceType: "wikipedia",
      title: String(row.pageTitle ?? "Wikipedia"),
      snippet: row.exists ? "Страница найдена" : "Страница не найдена",
      sourceUrl: row.url ?? undefined,
    });
    bump(countsByEvidenceType, "wikipedia");
  }

  const mediaCounts = countSearchSurfaceMediaAvailability(ctx.searchSurfaces);

  if (ctx.providerAvailability.unavailable.includes("yandex")) missingSources.push("yandex");
  if (ctx.providerAvailability.unavailable.includes("google")) missingSources.push("google");
  if (!ctx.lexis.uploadExists) missingSources.push("lexis_upload");
  if (ctx.searchResults.length === 0) warnings.push("no-search-results");

  return {
    version: "r10-full-evidence-inventory-v1",
    caseId,
    reportRunId,
    inspectedAt: now,
    subject: ctx.subject,
    counts: {
      searchResults: ctx.searchResults.length,
      searchSurfaces: ctx.searchSurfaces.length,
      databaseProfiles: ctx.databaseProfiles.length,
      riskFindings: ctx.riskFindings.length,
      wikiChecks: ctx.wikiChecks.length,
      screenshots: mediaCounts.serpScreenshots,
    },
    countsBySource,
    countsByRegion,
    countsByEvidenceType,
    mediaAvailability: {
      images: mediaCounts.images,
      videos: mediaCounts.videos,
      knowledgePanels: mediaCounts.knowledgePanels,
      serpScreenshots: mediaCounts.serpScreenshots,
      suggestions: mediaCounts.suggestions,
      relatedQueries: mediaCounts.relatedQueries,
      manualNotes: mediaCounts.manualNotes,
      organicResults: mediaCounts.organicResults,
    },
    lexisNexis: {
      uploadExists: ctx.lexis.uploadExists,
      latestReady: Boolean(ctx.lexis.latestReady),
      visualPageCount: ctx.lexis.visualPageCount,
      parsedSignals: ctx.lexis.parsedSignals,
      status: ctx.lexis.latestReady ? "ready" : ctx.lexis.uploadExists ? "uploaded" : "unavailable",
    },
    missingSources,
    warnings,
    items,
  };
}
