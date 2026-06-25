/**
 * Browser-side API client for the Digital Profile admin UI.
 *
 * All UI data flows through the JSON API routes (never Prisma directly). Every
 * call goes through `request`, which unwraps the `{ ok, data }` / `{ ok, error }`
 * envelope and throws a typed `DigitalProfileApiError` on failure so the UI can
 * branch on `code` (MODULE_DISABLED, NOT_FOUND, RENDERER_UNAVAILABLE, ...).
 *
 * Dates arrive as ISO strings over JSON, so client types use `string` dates.
 */

const BASE = "/api/digital-profile";
const ACTOR_HEADERS: Record<string, string> = { "x-actor-id": "admin-ui" };

export type ApiErrorCode =
  | "MODULE_DISABLED"
  | "VALIDATION_ERROR"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RENDERER_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR";

export class DigitalProfileApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: ApiErrorCode, status: number, message: string, details?: unknown) {
    super(message);
    this.name = "DigitalProfileApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ApiErrorCode; message: string; details?: unknown } };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...ACTOR_HEADERS,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch (err) {
    throw new DigitalProfileApiError(
      "NETWORK_ERROR",
      0,
      err instanceof Error ? err.message : "Network request failed"
    );
  }

  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    body = null;
  }

  if (!body) {
    throw new DigitalProfileApiError("INTERNAL_ERROR", res.status, "Malformed server response");
  }
  if (body.ok) return body.data;

  throw new DigitalProfileApiError(
    body.error.code ?? "INTERNAL_ERROR",
    res.status,
    body.error.message ?? "Request failed",
    body.error.details
  );
}

// ---------------------------------------------------------------------------
// Types (string dates, mirror server DTOs)
// ---------------------------------------------------------------------------

export interface CaseListItem {
  id: string;
  caseNumber: string;
  title: string;
  status: string;
  consentStatus: string;
  subjectName: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CaseSubject {
  id: string;
  fullName: string;
  aliases: string[];
  dateOfBirth: string | null;
  nationality: string | null;
  country: string | null;
}

export interface CaseDetail {
  id: string;
  caseNumber: string;
  title: string;
  status: string;
  lawfulBasis: string | null;
  consentStatus: string;
  targetRegions: string[];
  notes: string | null;
  createdBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  subject: CaseSubject | null;
}

export interface CreateCaseInput {
  fullName: string;
  aliases?: string[];
  birthDate?: string;
  targetRegions?: string[];
  lawfulBasis: string;
  consentStatus: string;
  notes?: string;
}

export interface EvidenceRef {
  type: string;
  refId?: string;
  url?: string;
  storageKey?: string;
  label?: string;
  capturedAt?: string;
}

export interface SearchQuery {
  id: string;
  engine: string;
  queryText: string;
  source: string;
  createdAt: string;
}

export interface SearchResult {
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
  createdAt: string;
}

export interface Screenshot {
  id: string;
  resultId: string | null;
  mimeType: string;
  sha256: string;
  sizeBytes: number | null;
  sourceUrl: string | null;
  capturedAt: string;
  downloadUrl: string;
}

export interface DatabaseProfile {
  id: string;
  provider: string;
  importMethod: string;
  matchType: string | null;
  matchScore: number | null;
  evidenceRefs: EvidenceRef[];
  importedAt: string;
}

export interface WikipediaCheck {
  id: string;
  exists: boolean;
  url: string | null;
  language: string | null;
  pageTitle: string | null;
  snapshot: unknown;
  checkedBy: string | null;
  lastChecked: string;
}

export interface AiProfile {
  id: string;
  model: string;
  summary: string | null;
  classifications: unknown;
  disclaimer: string;
  createdAt: string;
}

/** Permissive evidence ref covering legacy EvidenceRef and classifier refs. */
export interface FindingEvidenceRef {
  type?: string;
  id?: string;
  refId?: string;
  url?: string;
  title?: string;
  label?: string;
  provider?: string;
  source?: string;
}

export interface RiskFinding {
  id: string;
  category: string;
  severity: string;
  title: string;
  summary: string | null;
  evidenceRefs: FindingEvidenceRef[];
  reviewStatus: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  signalType?: string | null;
  riskTheme?: string | null;
  confidence?: number | null;
  rationale?: string | null;
  demo?: boolean;
  createdAt: string;
}

export interface RiskClassifySummary {
  totalEvidenceScanned: number;
  findingsCreated: number;
  findingsUpdated: number;
  findingsSkippedReviewed: number;
  findingsDismissedIgnored: number;
  highestRiskLevel: string;
}

export interface CaseEvidence {
  searchQueries: SearchQuery[];
  searchResults: SearchResult[];
  screenshots: Screenshot[];
  databaseProfiles: DatabaseProfile[];
  wikipediaChecks: WikipediaCheck[];
  aiProfiles: AiProfile[];
  riskFindings: RiskFinding[];
}

export interface ReportVersion {
  id: string;
  caseId: string;
  version: number;
  status: string;
  watermark: string | null;
  renderedAt: string | null;
  pptxDownloadUrl: string | null;
  pdfDownloadUrl: string | null;
  createdAt: string;
  reportJson?: unknown;
}

export interface RenderedReport {
  id: string;
  caseId: string;
  version: number;
  status: string;
  watermark: string | null;
  renderedAt: string | null;
  pptxDownloadUrl: string | null;
  pdfDownloadUrl: string | null;
  templateVersion?: string | null;
  slideCount?: number;
  warnings?: string[];
}

export interface AddSearchResultInput {
  engine: string;
  url: string;
  title?: string;
  classification?: string;
}

export type AgentKind = "MOCK" | "REAL";
export type AvailabilityStatus = "ENABLED" | "DISABLED" | "NOT_CONFIGURED";

export interface AgentAvailability {
  status: AvailabilityStatus;
  message?: string;
}

export interface AgentInfo {
  name: string;
  displayName: string;
  description: string;
  kind: AgentKind;
  enabled: boolean;
  availability: AgentAvailability;
  lastRun: {
    status: string;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
}

export interface AgentRun {
  id: string;
  agentName: string;
  kind: AgentKind;
  status: string;
  summary: string | null;
  itemsSaved: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export type CapabilityMethod = "OFFICIAL_API" | "MANUAL_IMPORT" | "NOT_SUPPORTED" | "SYNTHETIC";

export interface SurfaceCapability {
  supported: boolean;
  method: CapabilityMethod;
}

export interface ProviderCapabilities {
  organicSearch: SurfaceCapability;
  imageSearch: SurfaceCapability;
  videoSearch: SurfaceCapability;
  suggestions: SurfaceCapability;
  relatedQueries: SurfaceCapability;
  knowledgeBlock: SurfaceCapability;
  screenshots: SurfaceCapability;
  manualImport: SurfaceCapability;
}

export interface ProviderStatus {
  name: "WIKIPEDIA" | "GOOGLE" | "YANDEX";
  kind: "REAL";
  enabled: boolean;
  configured: boolean;
  status: AvailabilityStatus;
  missingConfigKeys: string[];
  supportsRealCalls: boolean;
  notes: string;
  capabilities: ProviderCapabilities;
}

// ---------------------------------------------------------------------------
// Stage H3 — search surfaces
// ---------------------------------------------------------------------------

export type SearchSurfaceType =
  | "ORGANIC_RESULT"
  | "SUGGESTION"
  | "RELATED_QUERY"
  | "IMAGE_RESULT"
  | "VIDEO_RESULT"
  | "KNOWLEDGE_BLOCK"
  | "SERP_SCREENSHOT"
  | "MANUAL_NOTE";

export type SearchSurfaceSource =
  | "MOCK"
  | "REAL_GOOGLE"
  | "REAL_YANDEX"
  | "REAL_WIKIPEDIA"
  | "MANUAL_IMPORT"
  | "SYNTHETIC_SNAPSHOT";

export interface SearchSurfaceItem {
  id: string;
  caseId: string;
  type: SearchSurfaceType;
  provider: string | null;
  source: SearchSurfaceSource;
  query: string | null;
  region: string | null;
  language: string | null;
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
  rawMetadata: unknown;
  capturedAt: string;
  demo: boolean;
  reviewStatus: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSurfaceInput {
  type: SearchSurfaceType;
  source?: SearchSurfaceSource;
  provider?: string;
  query?: string;
  region?: string;
  language?: string;
  title?: string;
  snippet?: string;
  url?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  videoUrl?: string;
  classification?: string;
  riskTheme?: string;
}

export type FullAuditOutcome = "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";

export interface FullAuditResult {
  outcome: FullAuditOutcome;
  runs: AgentRun[];
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export function listCases(params?: {
  page?: number;
  pageSize?: number;
  q?: string;
  status?: string;
}): Promise<Paginated<CaseListItem>> {
  const sp = new URLSearchParams();
  if (params?.page) sp.set("page", String(params.page));
  if (params?.pageSize) sp.set("pageSize", String(params.pageSize));
  if (params?.q) sp.set("q", params.q);
  if (params?.status) sp.set("status", params.status);
  const qs = sp.toString();
  return request<Paginated<CaseListItem>>(`/cases${qs ? `?${qs}` : ""}`);
}

export function createCase(input: CreateCaseInput): Promise<CaseDetail> {
  return request<CaseDetail>("/cases", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function getCase(caseId: string): Promise<CaseDetail> {
  return request<CaseDetail>(`/cases/${caseId}`);
}

export function getEvidence(caseId: string): Promise<CaseEvidence> {
  return request<CaseEvidence>(`/cases/${caseId}/evidence`);
}

export function addSearchResult(
  caseId: string,
  input: AddSearchResultInput
): Promise<{ result: SearchResult; deduplicated: boolean }> {
  return request(`/cases/${caseId}/search-results`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function reviewFinding(
  findingId: string,
  reviewStatus: "REVIEWED" | "DISMISSED"
): Promise<RiskFinding> {
  return request<RiskFinding>(`/findings/${findingId}/review`, {
    method: "POST",
    body: JSON.stringify({ reviewStatus }),
  });
}

export function classifyRisks(caseId: string): Promise<RiskClassifySummary> {
  return request<RiskClassifySummary>(`/cases/${caseId}/risk/classify`, {
    method: "POST",
  });
}

export interface AuditSummary {
  caseId: string;
  subjectFullName: string;
  generatedAt: string;
  overallRiskLevel: string;
  overallTone: string;
  executiveSummary: string[];
  keyFindings: { group: string; title: string; points: string[] }[];
  recommendedActions: string[];
  regions: {
    region: string;
    language: string;
    organicTotal: number;
    organicNegative: number;
    organicNegativeShare: number;
    uniqueNegativeUrls: number;
    suggestionsTotal: number;
    suggestionsNegative: number;
    imagesTotal: number;
    imagesNegative: number;
    videosTotal: number;
    videosNegative: number;
    knowledgeBlockStatus: string;
    regionRiskLevel: string;
    regionConclusion: string;
  }[];
  searchSummary: {
    totalResults: number;
    uniqueUrls: number;
    negativeResults: number;
    negativeShare: number;
    negativeDomains: string[];
    topNegativeThemes: { theme: string; count: number }[];
    topNegativeUrls: { url: string; title: string | null }[];
  };
  surfacesSummary: {
    suggestions: { total: number; negative: number; negativeShare: number };
    relatedQueries: { total: number; negative: number; negativeShare: number };
    images: { total: number; negative: number; negativeShare: number };
    videos: { total: number; negative: number; negativeShare: number };
    knowledgeBlocks: { total: number; mismatches: number };
    screenshots: number;
    syntheticSnapshots: number;
  };
  wikipediaSummary: {
    exists: boolean;
    pageUrl: string | null;
    language: string | null;
    notabilityScore: number;
    conclusion: string;
  };
  complianceDatabaseSummary: {
    providersChecked: string[];
    activeMatches: number;
    pepMatches: number;
    rcaMatches: number;
    sanctionsMatches: number;
    adverseMediaMatches: number;
    conclusion: string;
  };
  riskSummary: {
    highestRiskLevel: string;
    totalFindings: number;
    findingsByLevel: Record<string, number>;
    findingsByTheme: Record<string, number>;
    topFindings: {
      severity: string;
      theme: string;
      title: string;
      reviewStatus: string;
      evidenceCount: number;
    }[];
  };
  dataQualitySummary: {
    evidenceCount: number;
    reviewedFindings: number;
    pendingFindings: number;
    dismissedFindings: number;
    missingSections: string[];
    warnings: string[];
  };
}

export function buildAuditSummary(caseId: string): Promise<{ auditSummary: AuditSummary }> {
  return request<{ auditSummary: AuditSummary }>(`/cases/${caseId}/audit-summary/build`, {
    method: "POST",
  });
}

export function getAuditSummary(caseId: string): Promise<{ auditSummary: AuditSummary }> {
  return request<{ auditSummary: AuditSummary }>(`/cases/${caseId}/audit-summary`);
}

/** Returns the latest report version, or null if none has been generated. */
export async function getReport(caseId: string): Promise<ReportVersion | null> {
  try {
    return await request<ReportVersion>(`/cases/${caseId}/report`);
  } catch (err) {
    if (err instanceof DigitalProfileApiError && err.code === "NOT_FOUND") {
      return null;
    }
    throw err;
  }
}

export function generateReport(caseId: string): Promise<ReportVersion> {
  return request<ReportVersion>(`/cases/${caseId}/report/generate`, {
    method: "POST",
  });
}

export function renderReport(
  caseId: string,
  templateVersion?: string
): Promise<RenderedReport> {
  return request<RenderedReport>(`/cases/${caseId}/report/render`, {
    method: "POST",
    body: templateVersion ? JSON.stringify({ templateVersion }) : undefined,
  });
}

// ---------------------------------------------------------------------------
// Stage G — agents
// ---------------------------------------------------------------------------

export function listAgents(caseId: string): Promise<AgentInfo[]> {
  return request<AgentInfo[]>(`/cases/${caseId}/agents`);
}

export function listAgentRuns(caseId: string): Promise<AgentRun[]> {
  return request<AgentRun[]>(`/cases/${caseId}/agent-runs`);
}

export function runAgent(caseId: string, agentName: string): Promise<AgentRun> {
  return request<AgentRun>(`/cases/${caseId}/agents/${agentName}/run`, {
    method: "POST",
  });
}

export function runFullAudit(caseId: string): Promise<FullAuditResult> {
  return request<FullAuditResult>(`/cases/${caseId}/audit/run`, {
    method: "POST",
  });
}

export function listProviders(): Promise<ProviderStatus[]> {
  return request<ProviderStatus[]>("/providers");
}

// ---------------------------------------------------------------------------
// Stage H3 — search surfaces
// ---------------------------------------------------------------------------

export function listSearchSurfaces(
  caseId: string,
  filters?: { type?: SearchSurfaceType; source?: SearchSurfaceSource; provider?: string }
): Promise<SearchSurfaceItem[]> {
  const sp = new URLSearchParams();
  if (filters?.type) sp.set("type", filters.type);
  if (filters?.source) sp.set("source", filters.source);
  if (filters?.provider) sp.set("provider", filters.provider);
  const qs = sp.toString();
  return request<SearchSurfaceItem[]>(`/cases/${caseId}/search-surfaces${qs ? `?${qs}` : ""}`);
}

export function createSearchSurface(
  caseId: string,
  input: CreateSurfaceInput
): Promise<{ item: SearchSurfaceItem; deduplicated: boolean }> {
  return request(`/cases/${caseId}/search-surfaces`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function reviewSearchSurface(
  surfaceId: string,
  reviewStatus: "PENDING" | "REVIEWED" | "DISMISSED"
): Promise<SearchSurfaceItem> {
  return request<SearchSurfaceItem>(`/search-surfaces/${surfaceId}/review`, {
    method: "PATCH",
    body: JSON.stringify({ reviewStatus }),
  });
}

export function deleteSearchSurface(surfaceId: string): Promise<{ id: string }> {
  return request(`/search-surfaces/${surfaceId}`, { method: "DELETE" });
}
