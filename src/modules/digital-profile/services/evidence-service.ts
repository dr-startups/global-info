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
import { readRiskClassification } from "../risk-classifier/result-classifier";
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

import { URL_TRACKING_PARAMS } from "../url-tracking-params";

// ---------------------------------------------------------------------------
// URL normalization + de-duplication
// ---------------------------------------------------------------------------

/**
 * Список меток — общий с ключом материала слоя деки
 * (`serp-observation/material-key.ts`). Второй список здесь был бы вторым
 * ответом на вопрос «одна ли это страница», и он у нас уже был: адрес с
 * `?srsltid=` слой сбора считал новой строкой, а дека — новым материалом.
 */
const TRACKING_PARAMS = URL_TRACKING_PARAMS;

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
  source: string | null;
  createdAt: Date;
  /**
   * Stage N1.3 — derived risk classification (auto + manual override + the
   * effective decision). Never exposes the raw provider payload.
   */
  riskClassification?: ResultRiskClassificationDTO;
}

export interface ResultRiskClassificationDTO {
  auto: {
    classification: string;
    riskTheme: string | null;
    confidence: string;
    rationale: string;
  } | null;
  manual: {
    classification: string;
    riskTheme: string | null;
    rationale: string | null;
    reviewedBy: string | null;
    reviewedAt: string;
  } | null;
  effective: {
    classification: string;
    riskTheme: string | null;
    confidence: string | null;
    source: "manual" | "auto" | "none";
    manualOverride: boolean;
  };
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
  importedBy?: string | null;
  hitSource?: string;
  subjectName?: string | null;
  matchedName?: string | null;
  riskTypes?: string[];
  countries?: string[];
  confidence?: string | null;
  profileUrl?: string | null;
  summary?: string | null;
  reviewStatus?: string;
  reviewedBy?: string | null;
  reviewedAt?: Date | null;
  riskFindingId?: string | null;
  rawMetadataSafe?: unknown;
}

export interface WikipediaCheckDTO {
  id: string;
  exists: boolean;
  url: string | null;
  language: string | null;
  pageTitle: string | null;
  snapshot: unknown;
  checkedBy: string | null;
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
  signalType: string | null;
  riskTheme: string | null;
  confidence: number | null;
  rationale: string | null;
  demo: boolean;
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
  source: true,
  createdAt: true,
} satisfies Prisma.SearchResultSelect;

// Stage N1.3 — listing also reads rawMetadata to derive (never expose) the
// risk classification block.
const searchResultListSelect = {
  ...searchResultSelect,
  rawMetadata: true,
} satisfies Prisma.SearchResultSelect;

/** Builds the safe, derived risk-classification DTO from a row's rawMetadata. */
function toRiskClassificationDTO(rawMetadata: unknown): ResultRiskClassificationDTO | undefined {
  const block = readRiskClassification(rawMetadata);
  if (!block || (!block.auto && !block.manual)) return undefined;
  const auto = block.auto
    ? {
        classification: block.auto.classification,
        riskTheme: block.auto.riskTheme,
        confidence: block.auto.confidence,
        rationale: block.auto.rationale,
      }
    : null;
  const manual = block.manual
    ? {
        classification: block.manual.classification,
        riskTheme: block.manual.riskTheme,
        rationale: block.manual.rationale,
        reviewedBy: block.manual.reviewedBy,
        reviewedAt: block.manual.reviewedAt,
      }
    : null;
  const effective = manual
    ? {
        classification: manual.classification,
        riskTheme: manual.riskTheme,
        confidence: null as string | null,
        source: "manual" as const,
        manualOverride: true,
      }
    : auto
      ? {
          classification: auto.classification,
          riskTheme: auto.riskTheme,
          confidence: auto.confidence,
          source: "auto" as const,
          manualOverride: false,
        }
      : {
          classification: "UNKNOWN",
          riskTheme: null,
          confidence: null,
          source: "none" as const,
          manualOverride: false,
        };
  return { auto, manual, effective };
}

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
      checkedBy: true,
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
  signalType: true,
  riskTheme: true,
  confidence: true,
  rationale: true,
  demo: true,
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
      select: searchResultListSelect,
    }),
    prisma.screenshot.findMany({
      // Exclude synthetic SERP snapshots (Stage S1) — they are a generated
      // artifact, not raw captured evidence, and have their own tab.
      where: {
        caseId,
        deletedAt: null,
        NOT: { storageKey: { contains: "/serp-snapshots/" } },
      },
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
        importedBy: true,
        hitSource: true,
        subjectName: true,
        matchedName: true,
        riskTypes: true,
        countries: true,
        confidence: true,
        profileUrl: true,
        summary: true,
        reviewStatus: true,
        reviewedBy: true,
        reviewedAt: true,
        riskFindingId: true,
        rawMetadataSafe: true,
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
        checkedBy: true,
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
    searchResults: searchResults.map(({ rawMetadata, ...r }) => ({
      ...r,
      riskClassification: toRiskClassificationDTO(rawMetadata),
    })),
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
      riskTypes: Array.isArray(d.riskTypes) ? (d.riskTypes as string[]) : [],
      countries: Array.isArray(d.countries) ? (d.countries as string[]) : [],
    })),
    wikipediaChecks,
    aiProfiles,
    riskFindings: riskFindings.map((r) => ({
      ...r,
      evidenceRefs: asEvidenceRefs(r.evidenceRefs),
    })),
  };
}
