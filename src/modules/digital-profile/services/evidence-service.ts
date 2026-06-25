/**
 * Evidence service for the Digital Profile module (Stage C — manual input).
 *
 * Persists analyst-entered evidence for a case: search queries/results (with URL
 * de-duplication), database profiles (manual import), Wikipedia checks and risk
 * findings (with mandatory evidence references + human review).
 *
 * No collectors/agents and no LLM are involved here — this is manual input only.
 */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../http/errors";
import { recordAudit } from "./audit-log-service";
import { buildScreenshotDownloadUrl } from "../storage/signed-url";
import type { ActorContext } from "./case-service";
import type { EvidenceRef } from "../types";
import type {
  AddDatabaseProfileInput,
  AddRiskFindingInput,
  AddSearchQueryInput,
  AddSearchResultInput,
  AddWikipediaCheckInput,
  ClassifySearchResultInput,
  ReviewRiskFindingInput,
} from "../validation/evidence-schemas";

// ---------------------------------------------------------------------------
// URL normalization + de-duplication
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|yclid$|mc_)/i;

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    if (
      (u.protocol === "http:" && u.port === "80") ||
      (u.protocol === "https:" && u.port === "443")
    ) {
      u.port = "";
    }
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.test(key)) u.searchParams.delete(key);
    }
    const sorted = new URLSearchParams(
      [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
    );
    u.search = sorted.toString();
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw.trim().toLowerCase();
  }
}

function dedupHash(normalizedUrl: string): string {
  return createHash("sha256").update(normalizedUrl).digest("hex");
}

/** Strips `undefined` so values are valid Prisma JSON. */
function toJson<T>(value: T): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function ensureActiveCase(caseId: string): Promise<void> {
  const found = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Case not found");
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface SearchQueryDTO {
  id: string;
  engine: string;
  queryText: string;
  source: string;
  createdAt: Date;
}

export interface SearchResultDTO {
  id: string;
  queryId: string | null;
  engine: string;
  url: string;
  title: string | null;
  snippet: string | null;
  rank: number | null;
  classification: string;
  reviewStatus: string;
  createdAt: Date;
}

export interface ScreenshotDTO {
  id: string;
  resultId: string | null;
  mimeType: string;
  sha256: string;
  sizeBytes: number | null;
  sourceUrl: string | null;
  capturedAt: Date;
  downloadUrl: string;
}

export interface DatabaseProfileDTO {
  id: string;
  provider: string;
  importMethod: string;
  matchType: string | null;
  matchScore: number | null;
  evidenceRefs: EvidenceRef[];
  importedAt: Date;
}

export interface WikipediaCheckDTO {
  id: string;
  exists: boolean;
  url: string | null;
  language: string | null;
  pageTitle: string | null;
  snapshot: unknown;
  lastChecked: Date;
}

export interface AiProfileDTO {
  id: string;
  model: string;
  summary: string | null;
  classifications: unknown;
  disclaimer: string;
  createdAt: Date;
}

export interface RiskFindingDTO {
  id: string;
  category: string;
  severity: string;
  title: string;
  summary: string | null;
  evidenceRefs: EvidenceRef[];
  reviewStatus: string;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface CaseEvidenceDTO {
  searchQueries: SearchQueryDTO[];
  searchResults: SearchResultDTO[];
  screenshots: ScreenshotDTO[];
  databaseProfiles: DatabaseProfileDTO[];
  wikipediaChecks: WikipediaCheckDTO[];
  aiProfiles: AiProfileDTO[];
  riskFindings: RiskFindingDTO[];
}

function asEvidenceRefs(value: Prisma.JsonValue): EvidenceRef[] {
  return Array.isArray(value) ? (value as unknown as EvidenceRef[]) : [];
}

// ---------------------------------------------------------------------------
// Search queries
// ---------------------------------------------------------------------------

export async function addSearchQuery(
  caseId: string,
  input: AddSearchQueryInput,
  ctx: ActorContext = {}
): Promise<SearchQueryDTO> {
  await ensureActiveCase(caseId);
  const row = await prisma.searchQuery.create({
    data: {
      caseId,
      engine: input.engine,
      queryText: input.queryText,
      source: input.source,
      createdBy: ctx.actorId ?? null,
    },
    select: {
      id: true,
      engine: true,
      queryText: true,
      source: true,
      createdAt: true,
    },
  });
  await recordAudit({
    caseId,
    action: "SEARCH_QUERY_ADDED",
    actorId: ctx.actorId,
    metadata: { queryId: row.id, engine: input.engine },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Search results (with de-duplication)
// ---------------------------------------------------------------------------

export interface AddSearchResultOutput {
  result: SearchResultDTO;
  deduplicated: boolean;
}

const searchResultSelect = {
  id: true,
  queryId: true,
  engine: true,
  url: true,
  title: true,
  snippet: true,
  rank: true,
  classification: true,
  reviewStatus: true,
  createdAt: true,
} satisfies Prisma.SearchResultSelect;

export async function addSearchResult(
  caseId: string,
  input: AddSearchResultInput,
  ctx: ActorContext = {}
): Promise<AddSearchResultOutput> {
  await ensureActiveCase(caseId);
  const normalizedUrl = normalizeUrl(input.url);
  const hash = dedupHash(normalizedUrl);

  const existing = await prisma.searchResult.findUnique({
    where: { caseId_dedupHash: { caseId, dedupHash: hash } },
    select: searchResultSelect,
  });
  if (existing) {
    return { result: existing, deduplicated: true };
  }

  const result = await prisma.searchResult.create({
    data: {
      caseId,
      queryId: input.queryId ?? null,
      engine: input.engine,
      url: input.url,
      normalizedUrl,
      dedupHash: hash,
      title: input.title ?? null,
      snippet: input.snippet ?? null,
      rank: input.rank ?? null,
      classification: input.classification ?? "UNCLASSIFIED",
    },
    select: searchResultSelect,
  });
  await recordAudit({
    caseId,
    action: "SEARCH_RESULT_ADDED",
    actorId: ctx.actorId,
    metadata: { resultId: result.id, normalizedUrl },
  });
  return { result, deduplicated: false };
}

export async function classifySearchResult(
  resultId: string,
  input: ClassifySearchResultInput,
  ctx: ActorContext = {}
): Promise<SearchResultDTO> {
  const result = await prisma.searchResult.update({
    where: { id: resultId },
    data: {
      ...(input.classification !== undefined
        ? { classification: input.classification }
        : {}),
      ...(input.reviewStatus !== undefined
        ? { reviewStatus: input.reviewStatus }
        : {}),
    },
    select: { ...searchResultSelect, caseId: true },
  });
  await recordAudit({
    caseId: result.caseId,
    action: "SEARCH_RESULT_CLASSIFIED",
    actorId: ctx.actorId,
    metadata: { resultId, ...input },
  });
  const { caseId: _caseId, ...dto } = result;
  return dto;
}

// ---------------------------------------------------------------------------
// Database profiles (manual import only at this stage)
// ---------------------------------------------------------------------------

export async function addDatabaseProfile(
  caseId: string,
  input: AddDatabaseProfileInput,
  ctx: ActorContext = {}
): Promise<DatabaseProfileDTO> {
  await ensureActiveCase(caseId);
  const row = await prisma.databaseProfile.create({
    data: {
      caseId,
      provider: input.provider,
      importMethod: input.importMethod,
      matchType: input.matchType ?? null,
      matchScore: input.matchScore ?? null,
      rawPayload: input.rawPayload ? toJson(input.rawPayload) : undefined,
      evidenceRefs: toJson(input.evidenceRefs),
      importedBy: ctx.actorId ?? null,
    },
    select: {
      id: true,
      provider: true,
      importMethod: true,
      matchType: true,
      matchScore: true,
      evidenceRefs: true,
      importedAt: true,
    },
  });
  await recordAudit({
    caseId,
    action: "DATABASE_PROFILE_IMPORTED",
    actorId: ctx.actorId,
    metadata: { profileId: row.id, provider: input.provider },
  });
  return { ...row, evidenceRefs: asEvidenceRefs(row.evidenceRefs) };
}

// ---------------------------------------------------------------------------
// Wikipedia checks (manual record; never auto-published)
// ---------------------------------------------------------------------------

export async function addWikipediaCheck(
  caseId: string,
  input: AddWikipediaCheckInput,
  ctx: ActorContext = {}
): Promise<WikipediaCheckDTO> {
  await ensureActiveCase(caseId);
  const row = await prisma.wikipediaCheck.create({
    data: {
      caseId,
      exists: input.exists,
      url: input.url ?? null,
      language: input.language,
      pageTitle: input.pageTitle ?? null,
      snapshot: input.snapshot ? toJson(input.snapshot) : undefined,
      checkedBy: ctx.actorId ?? null,
    },
    select: {
      id: true,
      exists: true,
      url: true,
      language: true,
      pageTitle: true,
      snapshot: true,
      lastChecked: true,
    },
  });
  await recordAudit({
    caseId,
    action: "WIKIPEDIA_CHECK_ADDED",
    actorId: ctx.actorId,
    metadata: { checkId: row.id, exists: input.exists },
  });
  return row;
}

// ---------------------------------------------------------------------------
// Risk findings (evidence-first + human review)
// ---------------------------------------------------------------------------

const riskFindingSelect = {
  id: true,
  category: true,
  severity: true,
  title: true,
  summary: true,
  evidenceRefs: true,
  reviewStatus: true,
  reviewedBy: true,
  reviewedAt: true,
  createdAt: true,
} satisfies Prisma.RiskFindingSelect;

export async function addRiskFinding(
  caseId: string,
  input: AddRiskFindingInput,
  ctx: ActorContext = {}
): Promise<RiskFindingDTO> {
  await ensureActiveCase(caseId);
  const row = await prisma.riskFinding.create({
    data: {
      caseId,
      category: input.category,
      severity: input.severity,
      title: input.title,
      summary: input.summary ?? null,
      evidenceRefs: toJson(input.evidenceRefs),
      reviewStatus: "PENDING",
      createdBy: ctx.actorId ?? null,
    },
    select: riskFindingSelect,
  });
  await recordAudit({
    caseId,
    action: "RISK_FINDING_CREATED",
    actorId: ctx.actorId,
    metadata: { findingId: row.id, severity: input.severity },
  });
  return { ...row, evidenceRefs: asEvidenceRefs(row.evidenceRefs) };
}

export async function reviewRiskFinding(
  findingId: string,
  input: ReviewRiskFindingInput,
  ctx: ActorContext = {}
): Promise<RiskFindingDTO> {
  const row = await prisma.riskFinding.update({
    where: { id: findingId },
    data: {
      reviewStatus: input.reviewStatus,
      reviewedBy: input.reviewedBy ?? ctx.actorId ?? "system",
      reviewedAt: new Date(),
    },
    select: { ...riskFindingSelect, caseId: true },
  });
  await recordAudit({
    caseId: row.caseId,
    action: "RISK_FINDING_REVIEWED",
    actorId: ctx.actorId,
    metadata: { findingId, reviewStatus: input.reviewStatus },
  });
  const { caseId: _caseId, ...dto } = row;
  return { ...dto, evidenceRefs: asEvidenceRefs(dto.evidenceRefs) };
}

// ---------------------------------------------------------------------------
// Aggregate evidence listing
// ---------------------------------------------------------------------------

export async function listEvidence(caseId: string): Promise<CaseEvidenceDTO> {
  await ensureActiveCase(caseId);

  const [
    searchQueries,
    searchResults,
    screenshots,
    databaseProfiles,
    wikipediaChecks,
    aiProfiles,
    riskFindings,
  ] = await Promise.all([
    prisma.searchQuery.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        engine: true,
        queryText: true,
        source: true,
        createdAt: true,
      },
    }),
    prisma.searchResult.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      select: searchResultSelect,
    }),
    prisma.screenshot.findMany({
      where: { caseId, deletedAt: null },
      orderBy: { capturedAt: "desc" },
      select: {
        id: true,
        resultId: true,
        mimeType: true,
        sha256: true,
        sizeBytes: true,
        sourceUrl: true,
        capturedAt: true,
        storageKey: true,
      },
    }),
    prisma.databaseProfile.findMany({
      where: { caseId },
      orderBy: { importedAt: "desc" },
      select: {
        id: true,
        provider: true,
        importMethod: true,
        matchType: true,
        matchScore: true,
        evidenceRefs: true,
        importedAt: true,
      },
    }),
    prisma.wikipediaCheck.findMany({
      where: { caseId },
      orderBy: { lastChecked: "desc" },
      select: {
        id: true,
        exists: true,
        url: true,
        language: true,
        pageTitle: true,
        snapshot: true,
        lastChecked: true,
      },
    }),
    prisma.aiProfile.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        model: true,
        summary: true,
        classifications: true,
        disclaimer: true,
        createdAt: true,
      },
    }),
    prisma.riskFinding.findMany({
      where: { caseId },
      orderBy: { createdAt: "desc" },
      select: riskFindingSelect,
    }),
  ]);

  return {
    searchQueries,
    searchResults,
    screenshots: screenshots.map((s) => ({
      id: s.id,
      resultId: s.resultId,
      mimeType: s.mimeType,
      sha256: s.sha256,
      sizeBytes: s.sizeBytes,
      sourceUrl: s.sourceUrl,
      capturedAt: s.capturedAt,
      downloadUrl: buildScreenshotDownloadUrl(s.id, s.storageKey),
    })),
    databaseProfiles: databaseProfiles.map((d) => ({
      ...d,
      evidenceRefs: asEvidenceRefs(d.evidenceRefs),
    })),
    wikipediaChecks,
    aiProfiles,
    riskFindings: riskFindings.map((r) => ({
      ...r,
      evidenceRefs: asEvidenceRefs(r.evidenceRefs),
    })),
  };
}
