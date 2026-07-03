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
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RENDERER_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "NETWORK_ERROR";

const LOGIN_PATH = "/admin/digital-profile/login";

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

  // When auth is enabled and the session is missing/expired, bounce to login
  // (skip the auth endpoints themselves to avoid redirect loops).
  if (
    body.error.code === "UNAUTHORIZED" &&
    typeof window !== "undefined" &&
    !path.startsWith("/auth/") &&
    !window.location.pathname.startsWith(LOGIN_PATH)
  ) {
    const next = encodeURIComponent(window.location.pathname);
    window.location.assign(`${LOGIN_PATH}?next=${next}`);
  }

  throw new DigitalProfileApiError(
    body.error.code ?? "INTERNAL_ERROR",
    res.status,
    body.error.message ?? "Request failed",
    body.error.details
  );
}

// ---------------------------------------------------------------------------
// Auth (Stage M1)
// ---------------------------------------------------------------------------

export type DpRole =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "ANALYST"
  | "REVIEWER"
  | "CLIENT_VIEWER";

export interface CurrentUser {
  id: string;
  email: string;
  name: string;
  role: DpRole;
}

export interface MeResponse {
  authEnabled: boolean;
  user: CurrentUser | null;
}

export function getMe(): Promise<MeResponse> {
  return request<MeResponse>("/auth/me");
}

export function login(email: string, password: string): Promise<CurrentUser> {
  return request<CurrentUser>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>("/auth/logout", { method: "POST" });
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

export interface ResultRiskClassification {
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
  riskClassification?: ResultRiskClassification;
}

export interface ClassifyResultsSummary {
  totalScanned: number;
  classified: number;
  risky: number;
  findingsCreated: number;
  findingsUpdated: number;
  findingsSkippedReviewed: number;
  findingsDismissedIgnored: number;
}

export type ManualResultClass =
  | "RELEVANT"
  | "NEUTRAL"
  | "SOCIAL_PROFILE"
  | "CORPORATE"
  | "NEWS"
  | "ADVERSE_MEDIA"
  | "SANCTIONS"
  | "PEP"
  | "CRIMINAL"
  | "LEGAL_DISPUTE"
  | "HIGH_RISK"
  | "UNKNOWN";

export type ResultRiskThemeKey =
  | "sanctions"
  | "pep"
  | "legal_dispute"
  | "adverse_media"
  | "criminal"
  | "reputation"
  | "political_exposure"
  | "business_conflict"
  | "other";

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
  reviewedAt?: string | null;
  riskFindingId?: string | null;
}

export type ComplianceRiskType =
  | "SANCTIONS"
  | "PEP"
  | "ADVERSE_MEDIA"
  | "WATCHLIST"
  | "LAW_ENFORCEMENT"
  | "LEGAL"
  | "INSOLVENCY"
  | "POLITICAL_EXPOSURE"
  | "OTHER";

export type ComplianceHitReviewStatus =
  | "PENDING"
  | "MATCH_CONFIRMED"
  | "FALSE_POSITIVE"
  | "NEEDS_REVIEW"
  | "DISMISSED";

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
  audience?: string;
  watermarkMode?: string;
  reportLanguage?: string;
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
  name: "WIKIPEDIA" | "GOOGLE" | "YANDEX" | "DOW_JONES" | "LEXISNEXIS" | "WORLD_CHECK" | "MANUAL_IMPORT";
  kind: "MOCK" | "REAL" | "MANUAL";
  label: string;
  enabled: boolean;
  configured: boolean;
  status: AvailabilityStatus;
  missingConfigKeys: string[];
  supportsRealCalls: boolean;
  notes: string;
  capabilities?: ProviderCapabilities;
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

export interface FullAuditRunSummaryItem {
  providerId: string;
  phase: "collection" | "surfaces" | "enrichment" | "report";
  status: "completed" | "failed" | "skipped" | "unavailable";
  runtime: "real" | "mock" | "none";
  agentName?: string;
  fallbackAgent?: string;
  reason: string;
  runId?: string;
}

export interface FullAuditResult {
  outcome: FullAuditOutcome;
  runs: AgentRun[];
  runSummary?: FullAuditRunSummaryItem[];
  runtimeStrategy?: {
    mode: "legacy_mock_first" | "real_first_with_fallback" | "real_only" | "mock_only";
    selectedOrder: string[];
    fallbackPolicy: "allow_mock_fallback" | "allow_empty_fallback" | "no_mock_fallback";
    realProvidersAvailable: number;
    mockProvidersAvailable: number;
    fallbackEvents: Array<{
      providerId: string;
      reason: string;
      from: "real" | "mock" | "none";
      to: "real" | "mock" | "none";
    }>;
    warnings: string[];
    decisions: Array<{
      providerId: string;
      phase: "collection" | "surfaces" | "enrichment" | "report";
      status: "selected" | "skipped_unavailable" | "skipped_by_mode";
      selectedAgent?: string;
      selectedRuntime?: "real" | "mock";
      fallbackAgent?: string;
      reason: string;
    }>;
  };
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

// Stage N1.3 — search-result classification + manual override.
export function classifySearchResults(caseId: string): Promise<ClassifyResultsSummary> {
  return request<ClassifyResultsSummary>(`/cases/${caseId}/search-results/classify`, {
    method: "POST",
  });
}

export function setManualResultClassification(
  resultId: string,
  input: { classification: ManualResultClass; riskTheme?: ResultRiskThemeKey; rationale?: string }
): Promise<{ caseId: string }> {
  return request<{ caseId: string }>(`/search-results/${resultId}/classification`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function clearManualResultClassification(resultId: string): Promise<{ caseId: string }> {
  return request<{ caseId: string }>(`/search-results/${resultId}/classification`, {
    method: "DELETE",
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

export interface RenderReportOptions {
  templateVersion?: string;
  audience?: "internal" | "client";
  watermarkMode?: "draft" | "none";
  reportLanguage?: "ru" | "en";
}

export function renderReport(
  caseId: string,
  options?: RenderReportOptions
): Promise<RenderedReport> {
  return request<RenderedReport>(`/cases/${caseId}/report/render`, {
    method: "POST",
    body: options ? JSON.stringify(options) : undefined,
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

export function runFullAudit(
  caseId: string,
  options?: { runtimeMode?: "legacy_mock_first" | "real_first_with_fallback" | "real_only" | "mock_only" }
): Promise<FullAuditResult> {
  return request<FullAuditResult>(`/cases/${caseId}/audit/run`, {
    method: "POST",
    body: options ? JSON.stringify(options) : undefined,
  });
}

export function listProviders(): Promise<ProviderStatus[]> {
  return request<ProviderStatus[]>("/providers");
}

export function runComplianceScreening(
  caseId: string,
  provider: "DOW_JONES" | "LEXISNEXIS" | "WORLD_CHECK"
): Promise<{ status: string; hits: unknown[]; error?: { code: string; message: string } }> {
  return request(`/cases/${caseId}/compliance/screen`, {
    method: "POST",
    body: JSON.stringify({ provider }),
  });
}

export function importManualComplianceHit(
  caseId: string,
  input: {
    provider: string;
    matchedName: string;
    profileUrl?: string;
    profileId?: string;
    categories?: string[];
    riskTypes: ComplianceRiskType[];
    countries?: string[];
    datesOfBirth?: string[];
    summary?: string;
    evidenceUrl?: string;
    matchScore?: number;
    confidence?: "LOW" | "MEDIUM" | "HIGH";
  }
): Promise<DatabaseProfile> {
  return request<DatabaseProfile>(`/cases/${caseId}/compliance/manual-import`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function reviewComplianceHit(
  hitId: string,
  reviewStatus: ComplianceHitReviewStatus
): Promise<DatabaseProfile> {
  return request<DatabaseProfile>(`/database-profiles/${hitId}/review`, {
    method: "PATCH",
    body: JSON.stringify({ reviewStatus }),
  });
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

// ---------------------------------------------------------------------------
// Stage S1 — ORION-style synthetic SERP snapshot
// ---------------------------------------------------------------------------

export interface SerpSnapshot {
  id: string;
  storageKey: string;
  signedUrl: string;
  query: string;
  mode: "SYNTHETIC";
  engines: ("YANDEX" | "GOOGLE")[];
  language: "ru" | "en";
  themeCount: number;
  highlightedCount: number;
  resultCount: number;
  width: number;
  height: number;
  generatedAt: string;
  sha256: string;
  sizeBytes: number;
  /** Stage N1 — provenance of the underlying search_results. */
  sourceMode: "MOCK_ONLY" | "REAL_ONLY" | "MIXED" | "EMPTY";
  /** Stage N1.2 — selection strategy that produced this snapshot. */
  sourcePreference: SourcePreference;
  /** Stage N1.2 — per-engine source breakdown. */
  perEngine: {
    yandex: SerpEnginePerSource;
    google: SerpEnginePerSource;
  };
}

export type SourcePreference = "prefer_real" | "real_only" | "mock_only" | "mixed";

export interface SerpEnginePerSource {
  sourceMode: "REAL" | "MOCK" | "EMPTY";
  resultCount: number;
  highlightedCount: number;
}

export function generateSerpSnapshot(
  caseId: string,
  options?: { query?: string; language?: "ru" | "en"; sourcePreference?: SourcePreference }
): Promise<{ snapshot: SerpSnapshot }> {
  return request<{ snapshot: SerpSnapshot }>(`/cases/${caseId}/serp-snapshot/generate`, {
    method: "POST",
    body: JSON.stringify(options ?? {}),
  });
}

export function getSerpSnapshot(caseId: string): Promise<{ snapshot: SerpSnapshot | null }> {
  return request<{ snapshot: SerpSnapshot | null }>(`/cases/${caseId}/serp-snapshot`);
}
