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
  | "LEGACY_REPORT_PATH_RETIRED"
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
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...ACTOR_HEADERS,
        ...(init?.body && !isFormData ? { "content-type": "application/json" } : {}),
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
    const gatewayMsg =
      res.status === 502 || res.status === 504
        ? "Gateway timeout — generation may still be running. Refresh status in a minute."
        : "Malformed server response";
    throw new DigitalProfileApiError("INTERNAL_ERROR", res.status, gatewayMsg);
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
  rawMetadataSafe?: unknown;
}

export interface LexisNexisHybridImportResult {
  document: {
    id: string;
    sourceLabel?: string;
    fileName?: string;
    status:
      | "uploaded"
      | "converting"
      | "parsing"
      | "ready"
      | "conversion_warning"
      | "parse_warning"
      | "failed";
    pageCount: number;
    parsedAnalytics: {
      parserStatus: "parsed" | "partial" | "warning" | "failed";
      signalCounts: { totalSignals: number; reviewRequired: number };
    };
  };
  parsedSignalsCreated: number;
  reviewRequiredCount: number;
  parserStatus: "parsed" | "partial" | "warning" | "failed";
  conversionStatus: "ready" | "warning" | "failed";
}

export type ComplianceRiskType =
  | "SANCTIONS"
  // Приходит только от провайдера (тема `sanction.linked`): форма ручного
  // импорта этот тип не предлагает, но сервер его отдаёт, и описание ответа
  // обязано его знать.
  | "SANCTION_LINKED"
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
    outcome?: string | null;
    summary?: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  } | null;
  executionMode?: "SYNC" | "DURABLE_ASYNC";
}

export interface AgentRun {
  id: string;
  agentName: string;
  kind: AgentKind;
  status: string;
  summary: string | null;
  outcome?: string | null;
  executionId?: string | null;
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

// ---------------------------------------------------------------------------
// Легаси-контур отчёта здесь отсутствует намеренно (шаг 13, B6).
//
// GET /report, POST /report/generate, /report/render, /report/orion-v2 и
// /report/orion-client-storyboard отставлены на сервере (REMEDIATION 9.3) и
// отвечают 410 при любых настройках. Клиент их вызывал: при открытии кейса —
// сразу, остальные по кнопкам. В консоли браузера это выглядело как ошибка на
// каждом открытии, а кнопки не могли сработать ни при каких условиях.
// Актуальный путь — unified-collection и его артефакты.
// ---------------------------------------------------------------------------

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

export async function importLexisNexisDocx(
  caseId: string,
  file: File
): Promise<LexisNexisHybridImportResult> {
  const body = new FormData();
  body.append("file", file);
  return request<LexisNexisHybridImportResult>(`/cases/${caseId}/compliance/lexisnexis-import`, {
    method: "POST",
    body,
  });
}

export type ComplianceVisualImportResult = {
  profileId: string;
  provider: "DOW_JONES" | "WORLD_CHECK";
  pageCount: number;
  approved: true;
  storageKeys: string[];
  kind: "dow_jones_report" | "world_check_report";
};

export async function importComplianceVisualPages(
  caseId: string,
  input: {
    provider: "DOW_JONES" | "WORLD_CHECK";
    files: File[];
    matchedName?: string;
  }
): Promise<ComplianceVisualImportResult> {
  const body = new FormData();
  body.append("provider", input.provider);
  if (input.matchedName?.trim()) body.append("matchedName", input.matchedName.trim());
  for (const file of input.files) body.append("files", file);
  return request<ComplianceVisualImportResult>(`/cases/${caseId}/compliance/visual-import`, {
    method: "POST",
    body,
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

// ---------------------------------------------------------------------------
// R10.8 — ORION Golden manual review admin workflow
// ---------------------------------------------------------------------------

export type AdminReviewStatus =
  | "PENDING"
  | "APPROVED"
  | "APPROVED_WITH_CAVEAT"
  | "APPENDIX_ONLY"
  | "EXCLUDED"
  | "NEEDS_MORE_SOURCES"
  | "WRONG_SUBJECT";

export type ManualReviewQueueItemDto = {
  evidenceId: string;
  title: string;
  url?: string;
  sourceDomain?: string;
  snippet: string;
  proposedClassification: {
    subjectBinding: string;
    relevance: string;
    riskSignal: string;
    contentNature: string;
    reviewDecision: string;
  };
  whyAgentFlagged: string;
  riskInterpretation: string;
  neutralInterpretation: string;
  positiveInterpretation?: string;
  missingContext: string[];
  recommendedAdminAction: string;
  adminReviewStatus: AdminReviewStatus | string;
  flags: string[];
  sourceReliability?: string;
  subjectBindingScore?: number;
};

export type ManualReviewQueueDto = {
  version: string;
  generatedAt: string;
  caseId: string;
  reportRunId: string;
  pendingCount: number;
  items: ManualReviewQueueItemDto[];
  statusCounts?: Record<string, number>;
  gptAutoAnalystEnabled?: boolean;
};

export type ManualReviewItemDetailDto = ManualReviewQueueItemDto & {
  adminDecision: {
    evidenceId: string;
    status: AdminReviewStatus | string;
    reviewerNote?: string;
    reviewedBy?: string;
    reviewedAt?: string;
    approvedClientSummary?: string;
    caveatText?: string;
    requestedSources?: string[];
  };
  subjectBindingExplanation?: string;
  subjectBindingPositiveSignals?: string[];
  subjectBindingNegativeSignals?: string[];
  contentNature?: string;
  clientSafeSummary?: string;
};

export type AdminReviewDecisionSetDto = {
  version: string;
  caseId: string;
  generatedAt: string;
  updatedAt?: string;
  qaSampleOnly?: boolean;
  decisions: Array<{
    evidenceId: string;
    status: AdminReviewStatus | string;
    reviewerNote?: string;
    reviewedBy?: string;
    reviewedAt?: string;
    approvedClientSummary?: string;
    caveatText?: string;
    requestedSources?: string[];
  }>;
};

export type SubmitAdminReviewDecisionInput = {
  status: AdminReviewStatus;
  reviewerNote?: string;
  approvedClientSummary?: string;
  caveatText?: string;
  requestedSources?: string[];
  highImpactAcknowledged?: boolean;
  overwriteConfirmed?: boolean;
};

export type RegenerateClientContentResult = {
  preReviewApprovedCount: number;
  postReviewApprovedCount: number;
  mode: "post_review";
  artifactRoot?: string;
  generatedAt?: string;
  rendererInvoked?: boolean;
};

export function getOrionManualReviewQueue(caseId: string): Promise<ManualReviewQueueDto> {
  return request<ManualReviewQueueDto>(`/cases/${caseId}/orion-golden/manual-review`);
}

export function getOrionManualReviewItem(
  caseId: string,
  evidenceId: string
): Promise<ManualReviewItemDetailDto> {
  return request<ManualReviewItemDetailDto>(
    `/cases/${caseId}/orion-golden/manual-review/${encodeURIComponent(evidenceId)}`
  );
}

export function submitOrionAdminReviewDecision(
  caseId: string,
  evidenceId: string,
  input: SubmitAdminReviewDecisionInput
): Promise<AdminReviewDecisionSetDto> {
  return request<AdminReviewDecisionSetDto>(
    `/cases/${caseId}/orion-golden/manual-review/${encodeURIComponent(evidenceId)}`,
    { method: "POST", body: JSON.stringify(input) }
  );
}

export function listOrionAdminReviewDecisions(caseId: string): Promise<AdminReviewDecisionSetDto> {
  return request<AdminReviewDecisionSetDto>(`/cases/${caseId}/orion-golden/admin-review-decisions`);
}

export function regenerateOrionClientContentAfterReview(
  caseId: string
): Promise<RegenerateClientContentResult> {
  return request<RegenerateClientContentResult>(
    `/cases/${caseId}/orion-golden/client-content/regenerate`,
    { method: "POST", body: JSON.stringify({}) }
  );
}

// ---------------------------------------------------------------------------
// Stage S2 — LIVE SERP browser captures (manual API; not invoked by renderer)
// ---------------------------------------------------------------------------

export type SerpCaptureEngine = "GOOGLE" | "YANDEX";
export type SerpCaptureRegion = "RU" | "UAE";
export type SerpCaptureStatus =
  | "PENDING"
  | "RUNNING"
  | "READY"
  | "BLOCKED_CAPTCHA"
  | "FAILED";

export type SerpCaptureDto = {
  id: string;
  caseId: string;
  reportRunId: string;
  query: string;
  queryHash: string;
  engine: SerpCaptureEngine;
  region: SerpCaptureRegion;
  locale: string;
  device: string;
  captureStatus: SerpCaptureStatus;
  geoStatus: "VERIFIED" | "UNVERIFIED" | "UNKNOWN";
  connectionMode: "PROXY" | "DIRECT";
  storageKey: string | null;
  sha256: string | null;
  sourceUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  capturedAt: string | null;
  capturedBy: string | null;
  metadataJson: Record<string, unknown> | null;
  errorJson: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export function listSerpCaptures(
  caseId: string,
  reportRunId: string
): Promise<{ captures: SerpCaptureDto[] }> {
  return request<{ captures: SerpCaptureDto[] }>(
    `/cases/${caseId}/report-runs/${reportRunId}/serp-captures`
  );
}

export function captureLiveSerp(
  caseId: string,
  reportRunId: string,
  input: {
    query: string;
    engine: SerpCaptureEngine;
    region: SerpCaptureRegion;
    locale?: string;
    device?: "DESKTOP";
  }
): Promise<{ capture: SerpCaptureDto }> {
  return request<{ capture: SerpCaptureDto }>(
    `/cases/${caseId}/report-runs/${reportRunId}/serp-captures/live`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  );
}

/**
 * Canonical, lineage-safe download URL for an accepted unified-job artifact.
 * Only valid once the job is REPORT_READY; the server re-validates lineage.
 * Does not start collection, recovery, or render — GET download only.
 */
export function getCanonicalArtifactDownloadUrl(
  caseId: string,
  jobId: string,
  artifact: "pdf" | "pptx" | "contactSheet"
): string {
  const q = new URLSearchParams({ jobId, artifact });
  return `${BASE}/cases/${caseId}/unified-collection/download?${q.toString()}`;
}

/** REMEDIATION §8.3 — support zip of JSON/text job artifacts (no binaries). */
export function getUnifiedDiagnosticsBundleUrl(caseId: string, jobId: string): string {
  const q = new URLSearchParams({ jobId });
  return `${BASE}/cases/${caseId}/unified-collection/diagnostics-bundle?${q.toString()}`;
}

export type OrionGoldenPrepareSummary = {
  ok: boolean;
  caseId: string;
  jobId: string | null;
  status: "completed" | "failed" | "running" | "empty";
  runId: string | null;
  verdict: string | null;
  artifactRoot: string | null;
  pdf: string | null;
  pptx: string | null;
  pageCount: number;
  queueReady: boolean;
  createdAt: string | null;
  completedAt: string | null;
  warnings: string[];
};

export function prepareOrionGoldenArtifacts(
  caseId: string,
  jobId: string
): Promise<OrionGoldenPrepareSummary> {
  return request<OrionGoldenPrepareSummary>(`/cases/${caseId}/orion-golden/prepare`, {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}

// ---------------------------------------------------------------------------
// Unified ORION collection (base + Arsenkin + composite + Golden)
// ---------------------------------------------------------------------------

/** Compact report-quality payload from GET unified-collection (REMEDIATION §0.1/0.4). */
export type JobReportQualityDTO = {
  version: string;
  generatedAt: string;
  counts: {
    dbSearchResults: number | null;
    dbSurfaceItems: number | null;
    manifestIds: number | null;
    manifestDeltaCount?: number | null;
    manifestCorpusCount?: number | null;
    compositeObservations: number | null;
    subjectMatch: number | null;
    likelySubject?: number | null;
    ambiguous: number | null;
    otherSubject: number | null;
    insufficient: number | null;
    verifiedFindings: number | null;
    ambiguousFindings: number | null;
  };
  gpt: {
    stage1Status: string;
    stage1Reason?: string;
    stage2Applied: number;
    stage2NoChanges?: number;
    stage2SkippedCached?: number;
    stage2SkippedDeterministic?: number;
    stage2FallbackError: number;
    stage2FallbackValidation: number;
    caseAnalysisUsed: boolean;
  };
  visuals: { built: number; failed: number; warning: string | null };
  slides: {
    total: number;
    withContent: number;
    emptyStateCount: number;
    /** Absent on jobs saved before remediation §0.4. */
    emptyState?: Array<{ slotId: string; reason: string }>;
  };
  arsenkin: {
    enrichmentComplete: boolean | null;
    enrichmentObservationCount: number | null;
    agentsOk: number;
    agentsFailed: number;
  };
  /** REMEDIATION §6.2 — absent on jobs saved before soft sidebar degrade. */
  render?: {
    pdfExportMode: string | null;
    warningCount: number;
    sidebarDegradedCount: number;
  };
};

export type UnifiedCollectionJobStatus = {
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
  progress: number;
  actualProviders: Array<{
    providerId: string;
    agentName?: string;
    runtime: string;
    status: string;
    reason?: string;
  }>;
  coverage: {
    plannedSupportedSurfaces: number;
    measured: number;
    noResults: number;
    notSupported: number;
    failedFinal: number;
    failedRetryable: number;
    inFlight: number;
    progressRatio: number;
  } | null;
  warnings: string[];
  /** Funnel / GPT / empty-state quality summary when prepare has run. */
  reportQuality?: JobReportQualityDTO | null;
  lastError: string | null;
  lastErrorCode: string | null;
  baseReportRunId: string | null;
  arsenkinReportRunId: string | null;
  enrichmentRunIds?: string[];
  compositeDatasetId: string | null;
  reportLinks: { pdf?: string; pptx?: string; contactSheet?: string };
  /** Server-side fail-closed availability for Unified download buttons. */
  downloadArtifacts?: { pdf: boolean; pptx: boolean; contactSheet: boolean };
  artifactPaths: Record<string, string>;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  /**
   * Агенты, включённые составом прогона: знаменатель прогресса Arsenkin.
   * Раньше он был литералом `5` в интерфейсе, и при составе по умолчанию
   * (работают трое) исправный прогон показывался как «3/5».
   */
  arsenkinPlannedAgents?: string[];
  /** Arsenkin contract — schedule ≠ complete. */
  arsenkinEnrichmentState?: {
    scheduledAgents: string[];
    completedAgents: string[];
    failedAgents: string[];
    pendingAgents: string[];
    ingestedAgents: string[];
    enrichmentObservationCount: number;
    enrichmentComplete: boolean;
  } | null;
  /** Server-calculated — never trust a client-only flag. */
  recoveryAllowed?: boolean;
  /** Конвейер вернётся к работе сам — вмешательство не требуется (шаг 14). */
  autoResumePending?: boolean;
  autoResumeAt?: string | null;
  autoResumeStep?: string | null;
  recoveryBlockerReason?: string | null;
  recoveryReason?: string | null;
  fullAuditBlocked?: boolean;
  fullAuditBlockReason?: string | null;
  paidRecollectionRequired?: boolean;
  recoveryAudit?: {
    recoveredFromStatus: string;
    recoveredFromStage: string;
    recoveryRequestedAt: string;
    recoveryRequestedBy: string;
    recoveryReason: string;
    previousLastError: string | null;
    previousLastErrorCode: string | null;
  } | null;
  resumeCheckpoint?: string | null;
  /** Server-side eligibility for «Пересобрать отчёт» (analytics+render only, no paid collection). */
  rebuildAllowed?: boolean;
  rebuildBlockerReason?: string | null;
  /** Пауза идущего прогона: собранное остаётся, сбор продолжается с места остановки. */
  pauseAllowed?: boolean;
  pauseBlockerReason?: string | null;
  /** REMEDIATION §4.3 — selective GPT stage-2 FALLBACK_* retry (no paid collection). */
  gptCopyRetryAllowed?: boolean;
  gptCopyRetryBlockerReason?: string | null;
  gptCopyFallbackFragmentCount?: number;
  /** Durable Arsenkin poll cadence (persists across F5 / restart). */
  nextPollAt?: string | null;
  pollAttempt?: number;
  /** Suggestions enrichment gap — targeted paid retry. */
  suggestionsMissingResult?: boolean;
  suggestionsFailureReason?: string | null;
  suggestionsRetryAllowed?: boolean;
  suggestionsEnrichmentRunId?: string | null;
  suggestionsAgentName?: "ARSENKIN_SUGGESTIONS_REAL";
};

export function startUnifiedOrionCollection(
  caseId: string,
  opts?: { confirmPaidRecollection?: boolean }
): Promise<{ accepted: boolean; jobId: string; unifiedJobId: string; created: boolean; stage: string }> {
  return request(`/cases/${caseId}/unified-collection`, {
    method: "POST",
    body: JSON.stringify({
      arsenkinMode: "full-first36",
      confirmPaidRecollection: Boolean(opts?.confirmPaidRecollection),
    }),
  });
}

export function recoverUnifiedOrionCollection(
  caseId: string,
  jobId: string
): Promise<{
  accepted: boolean;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
  baseReportRunId: string;
  recoveryReason: string;
  createdBaseReportRun: boolean;
  idempotent: boolean;
}> {
  return request(`/cases/${caseId}/unified-collection/recover`, {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}

// ---------------------------------------------------------------------------
// Subject identity profile (classification context) — case-owned artifact
// ---------------------------------------------------------------------------

export type SubjectIdentityProfileDTO = {
  version?: string;
  caseId: string;
  displayName: string;
  fullNameRu?: { lastName: string; firstName: string; patronymic?: string };
  contextIdentifiers?: string[];
  namesakeProfiles?: Array<{ label: string; noiseTerms: string[] }>;
  aliases: string[];
  transliterations: string[];
  queryVariants?: string[];
  knownIdentifiers?: { inn?: string[]; ogrn?: string[]; ogrnip?: string[]; locations?: string[] };
  negativeIdentitySignals?: {
    wrongPatronymics: string[];
    wrongNames: string[];
    wrongBirthDates?: string[];
    unrelatedKnownPersons: string[];
  };
  regionHints?: string[];
  languageHints?: string[];
};

export type SubjectProfileEditsInput = {
  contextIdentifiers?: string[];
  aliases?: string[];
  unrelatedKnownPersons?: string[];
  wrongPatronymics?: string[];
  namesakeProfiles?: Array<{ label: string; noiseTerms: string[] }>;
  inn?: string[];
};

export function getSubjectIdentityProfile(
  caseId: string
): Promise<{ profile: SubjectIdentityProfileDTO; exists: boolean }> {
  return request(`/cases/${caseId}/subject-profile`);
}

export function saveSubjectIdentityProfile(
  caseId: string,
  edits: SubjectProfileEditsInput
): Promise<{ profile: SubjectIdentityProfileDTO; droppedSelfConflicting: string[] }> {
  // Persists classification context only — never triggers collection/render.
  return request(`/cases/${caseId}/subject-profile`, {
    method: "PUT",
    body: JSON.stringify(edits),
  });
}

export function rebuildUnifiedReport(
  caseId: string,
  jobId: string
): Promise<{
  accepted: boolean;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
  subjectProfileRefreshed: boolean;
}> {
  // Rebuild only re-runs analytics/assembly/render from persisted composite —
  // never POST /unified-collection (paid) and never /recover.
  return request(`/cases/${caseId}/unified-collection/rebuild-report`, {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}

/**
 * Просит идущий прогон остановиться.
 *
 * Пауза — не отмена: собранное остаётся, прогон возобновляется с места
 * остановки, и отчёт из уже собранного собрать можно. Денег не тратит —
 * никакого `POST /unified-collection`.
 */
export function pauseUnifiedCollection(
  caseId: string,
  jobId: string
): Promise<{
  accepted: boolean;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
}> {
  return request(`/cases/${caseId}/unified-collection/pause`, {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}

export function retryUnifiedGptCopy(
  caseId: string,
  jobId: string
): Promise<{
  accepted: boolean;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
  resumeCheckpoint: string;
  fallbackFragmentCount: number;
}> {
  // Selective stage-2 retry only — never paid collection / full rebuild.
  return request(`/cases/${caseId}/unified-collection/retry-gpt-copy`, {
    method: "POST",
    body: JSON.stringify({ jobId }),
  });
}

export function retryUnifiedEnrichmentSuggestionsTask(
  caseId: string,
  input: {
    jobId: string;
    enrichmentRunId: string;
    /** Server accepts "SUGGESTIONS" or "ARSENKIN_SUGGESTIONS_REAL"; UI always sends SUGGESTIONS. */
    agentName?: string;
    expectedTaskFingerprint?: string;
    confirmPaidEnrichmentRetry: boolean;
  }
): Promise<{
  accepted: boolean;
  jobId: string;
  unifiedJobId: string;
  enrichmentRunId: string;
  externalTaskId: string;
  submissions: number;
  reusedExisting: boolean;
  stage: string;
  status: string;
}> {
  // Targeted retry only — never POST /unified-collection or /recover.
  return request(`/cases/${caseId}/unified-collection/retry-enrichment-task`, {
    method: "POST",
    body: JSON.stringify({
      jobId: input.jobId,
      enrichmentRunId: input.enrichmentRunId,
      agentName: input.agentName ?? "SUGGESTIONS",
      ...(input.expectedTaskFingerprint
        ? { expectedTaskFingerprint: input.expectedTaskFingerprint }
        : {}),
      confirmPaidEnrichmentRetry: input.confirmPaidEnrichmentRetry === true,
    }),
  });
}

export function getUnifiedOrionCollectionStatus(
  caseId: string
): Promise<{ job: UnifiedCollectionJobStatus | null }> {
  return request(`/cases/${caseId}/unified-collection`, { cache: "no-store" });
}

export function getOrionGoldenPrepareStatus(
  caseId: string
): Promise<OrionGoldenPrepareSummary> {
  return request<OrionGoldenPrepareSummary>(`/cases/${caseId}/orion-golden/prepare`);
}

// ---------------------------------------------------------------------------
// Arsenkin Tools UI (API collector — not Playwright LIVE SERP)
// ---------------------------------------------------------------------------

export type ArsenkinUiStage = "SUGGEST_RU_CANARY" | "FIRST36_STAGE1" | "FIRST36_STAGE2";

export type ArsenkinUiStatusCode =
  | "NOT_CONFIGURED"
  | "READINESS_RUNNING"
  | "READY_TO_PREPARE"
  | "PREPARED"
  | "PLAN_READY"
  | "EXECUTING"
  | "STAGE_DONE"
  | "SYNC_READY"
  | "READY_TO_TRANSFER"
  | "TRANSFERRING"
  | "SYNCED"
  | "TRANSFERRED"
  | "TRANSFER_FAILED"
  | "REPORT_BOUND"
  | "BLOCKED"
  | "FAILED"
  | "MANUAL_INTERVENTION_REQUIRED";

export type ArsenkinSurfaceMatrixStatus =
  | "NOT STARTED"
  | "PLANNED"
  | "RUNNING"
  | "MEASURED"
  | "NO RESULTS"
  | "FAILED PARSE"
  | "SUBMIT UNKNOWN"
  | "RESULT FETCH FAILED"
  | "DONE"
  | "FAILED";

export type ArsenkinSurfaceMatrixRow = {
  id: string;
  label: string;
  tool: "check-top" | "suggest" | "paa" | "ai-serp" | "check-h" | "indexation";
  engine: string;
  region: string;
  surface: string;
  status: ArsenkinSurfaceMatrixStatus;
  observationsCount: number;
  tasksCount: number;
};

export type ArsenkinRecoveryUiState = {
  submitUnknown: Array<{
    providerTaskId: string;
    toolName: string;
    requestHash: string;
    errorCode: string | null;
    externalTaskId: string | null;
    engine: string | null;
    region: string | null;
    query: string | null;
    createdAt: string;
    httpStatus: number | null;
    sanitizedRequest: Record<string, unknown>;
    sanitizedResponse: Record<string, unknown> | null;
    canLinkExisting: boolean;
    canConfirmNotCreated: boolean;
    canRetryAfterConfirm: boolean;
  }>;
  doneZeroObservations: Array<{
    providerTaskId: string;
    toolName: string;
    externalTaskId: string;
    requestHash: string;
  }>;
  canReconcileDoneZeroObs: boolean;
  canContinueStage1: boolean;
  canRetryUnconfirmed: boolean;
};

export type ArsenkinUiStatusDto = {
  enabled: boolean;
  configured: boolean;
  caseId: string;
  workflow: "suggest-canary" | "first36-full" | null;
  stage: ArsenkinUiStage | null;
  reportRunId: string | null;
  sourceReportRunId: string | null;
  arsenkinReportRunId: string | null;
  status: ArsenkinUiStatusCode;
  verdict: string | null;
  tools: string[];
  planDigest: string | null;
  plannedRequests: ArsenkinUiPlanRequestDto[];
  plannedNewTasks: number | null;
  estimatedLimitsTotal: number | null;
  maxNewTasks: number;
  maxEstimatedLimits: number;
  networkCalls: number;
  collectorCalls: number | null;
  providerTaskCount: number;
  observationCount: number;
  coverageCount: number;
  blockers: string[];
  lastError: string | null;
  canPrepare: boolean;
  canPlan: boolean;
  canExecute: boolean;
  canSync: boolean;
  synced: boolean;
  transferStatus?: "READY_TO_TRANSFER" | "TRANSFERRING" | "TRANSFERRED" | "TRANSFER_FAILED" | "REPORT_BOUND" | null;
  effectiveReportRunId?: string | null;
  transferredAt?: string | null;
  updatedAt: string;
  humanMessages: string[];
  readinessCode?:
    | "READINESS_PASS"
    | "READINESS_RUNNING"
    | "READINESS_ARTIFACT_MISSING"
    | "READINESS_STALE_BUILD"
    | "READINESS_ENV_MISMATCH"
    | "READINESS_FAILED"
    | "READINESS_SKIPPED"
    | "READINESS_NOT_REQUIRED"
    | null;
  canRefreshReadiness?: boolean;
  surfaceMatrix?: ArsenkinSurfaceMatrixRow[];
  recovery?: ArsenkinRecoveryUiState | null;
  orchestration?: {
    jobId: string;
    state: string;
    humanPhase: string;
    percent: number;
    surfacesDone: number;
    surfacesTotal: number;
    observationCount: number;
    nextStep: string;
    lastError: string | null;
    attempt: number;
    cancelRequested: boolean;
    orchestrationResumeCount?: number;
    providerSubmitAttempt?: number;
    providerCheckAttempt?: number;
    providerFetchAttempt?: number;
    humanMessage?: string | null;
    nextRetryAt?: string | null;
    requestedWorkflowType?: "SUGGEST_RU_CANARY" | "FIRST36_FULL";
    jobWorkflowType?: "SUGGEST_RU_CANARY" | "FIRST36_FULL";
    jobReportRunId?: string;
    sourceOrionReportRunId?: string | null;
    currentlyBoundReportRunId?: string | null;
    previousBindingReportRunId?: string | null;
    expectedSurfaceCount?: number;
    terminalSurfaceCount?: number;
    stage1TerminalCount?: number;
    stage2TerminalCount?: number;
  } | null;
  jobReportRunId?: string | null;
  sourceOrionReportRunId?: string | null;
  previousBindingReportRunId?: string | null;
  currentlyBoundReportRunId?: string | null;
  baseOrionReportRunId?: string | null;
  enrichmentReportRunId?: string | null;
  previousEnrichmentReportRunId?: string | null;
  sourceBindingAutoRepairable?: boolean;
  requestedWorkflowType?: "SUGGEST_RU_CANARY" | "FIRST36_FULL" | null;
  jobWorkflowType?: "SUGGEST_RU_CANARY" | "FIRST36_FULL" | null;
  expectedSurfaceCount?: number | null;
  terminalSurfaceCount?: number | null;
  runScopedDataMismatch?: string | null;
};

export type ArsenkinUiPlanRequestDto = {
  tool: string;
  engine: string;
  region: string;
  query: string | null;
  action: string;
  requestHash: string;
};

export type ArsenkinUiPlanDto = ArsenkinUiStatusDto & {
  requests: ArsenkinUiPlanRequestDto[];
  digest: string;
};

export type ArsenkinUiActionPayload = {
  reportRunId: string;
  stage: ArsenkinUiStage;
};

export type ArsenkinUiExecutePayload = ArsenkinUiActionPayload & {
  confirmPlanDigest: string;
  confirmed: true;
};

export function getArsenkinStatus(
  caseId: string,
  params?: { reportRunId?: string; stage?: ArsenkinUiStage }
): Promise<ArsenkinUiStatusDto> {
  const q = new URLSearchParams();
  if (params?.reportRunId) q.set("reportRunId", params.reportRunId);
  if (params?.stage) q.set("stage", params.stage);
  const qs = q.toString();
  return request<ArsenkinUiStatusDto>(
    `/cases/${caseId}/orion-golden/arsenkin${qs ? `?${qs}` : ""}`
  );
}

export function prepareArsenkinRun(
  caseId: string,
  payload: ArsenkinUiActionPayload
): Promise<ArsenkinUiStatusDto> {
  return request<ArsenkinUiStatusDto>(`/cases/${caseId}/orion-golden/arsenkin`, {
    method: "POST",
    body: JSON.stringify({ action: "prepare", ...payload }),
  });
}

export function planArsenkinRun(
  caseId: string,
  payload: ArsenkinUiActionPayload
): Promise<ArsenkinUiPlanDto> {
  return request<ArsenkinUiPlanDto>(`/cases/${caseId}/orion-golden/arsenkin`, {
    method: "POST",
    body: JSON.stringify({ action: "plan", ...payload }),
  });
}

export function executeArsenkinRun(
  caseId: string,
  payload: ArsenkinUiExecutePayload
): Promise<ArsenkinUiStatusDto> {
  return request<ArsenkinUiStatusDto>(`/cases/${caseId}/orion-golden/arsenkin`, {
    method: "POST",
    body: JSON.stringify({ action: "execute", ...payload }),
  });
}

export function syncArsenkinRun(
  caseId: string,
  payload: ArsenkinUiActionPayload
): Promise<ArsenkinUiStatusDto & { orphanedEvidenceIds?: string[] }> {
  return request<ArsenkinUiStatusDto & { orphanedEvidenceIds?: string[] }>(
    `/cases/${caseId}/orion-golden/arsenkin`,
    {
      method: "POST",
      body: JSON.stringify({ action: "sync", ...payload }),
    }
  );
}

export function refreshArsenkinDbReadiness(
  caseId: string,
  params?: { reportRunId?: string; stage?: ArsenkinUiStage }
): Promise<ArsenkinUiStatusDto> {
  return request<ArsenkinUiStatusDto>(`/cases/${caseId}/orion-golden/arsenkin`, {
    method: "POST",
    body: JSON.stringify({
      action: "refresh-readiness",
      reportRunId: params?.reportRunId,
      stage: params?.stage,
    }),
  });
}

export function recoverArsenkinLinkExisting(
  caseId: string,
  payload: ArsenkinUiActionPayload & { providerTaskId: string; externalTaskId: string; evidenceNote?: string }
): Promise<ArsenkinUiStatusDto> {
  return request<ArsenkinUiStatusDto>(`/cases/${caseId}/orion-golden/arsenkin`, {
    method: "POST",
    body: JSON.stringify({ action: "recover-link-existing", ...payload }),
  });
}

export function recoverArsenkinConfirmNotCreated(
  caseId: string,
  payload: ArsenkinUiActionPayload & { providerTaskId: string; reason: string; evidenceNote?: string }
): Promise<ArsenkinUiStatusDto> {
  return request<ArsenkinUiStatusDto>(`/cases/${caseId}/orion-golden/arsenkin`, {
    method: "POST",
    body: JSON.stringify({ action: "recover-confirm-not-created", ...payload }),
  });
}

export function recoverArsenkinRetryUnconfirmed(
  caseId: string,
  payload: ArsenkinUiActionPayload & { providerTaskId: string }
): Promise<ArsenkinUiStatusDto> {
  return request<ArsenkinUiStatusDto>(`/cases/${caseId}/orion-golden/arsenkin`, {
    method: "POST",
    body: JSON.stringify({ action: "recover-retry-unconfirmed", ...payload }),
  });
}

export function recoverArsenkinReconcileDone(
  caseId: string,
  payload: ArsenkinUiActionPayload
): Promise<ArsenkinUiStatusDto & { reconcileResults?: unknown }> {
  return request<ArsenkinUiStatusDto & { reconcileResults?: unknown }>(
    `/cases/${caseId}/orion-golden/arsenkin`,
    {
      method: "POST",
      body: JSON.stringify({ action: "recover-reconcile-done", ...payload }),
    }
  );
}

export function recoverArsenkinContinueStage1(
  caseId: string,
  payload: ArsenkinUiActionPayload & { confirmPlanDigest: string; confirmed: true }
): Promise<ArsenkinUiStatusDto> {
  return request<ArsenkinUiStatusDto>(`/cases/${caseId}/orion-golden/arsenkin`, {
    method: "POST",
    body: JSON.stringify({ action: "recover-continue-stage1", ...payload }),
  });
}

export function startArsenkinFullAudit(
  caseId: string,
  payload: ArsenkinUiActionPayload & { confirmed: true; forceNewRun?: boolean }
): Promise<
  ArsenkinUiStatusDto & {
    accepted?: boolean;
    jobId?: string;
    created?: boolean;
    orchestration?: ArsenkinUiStatusDto["orchestration"];
  }
> {
  return request(`/cases/${caseId}/orion-golden/arsenkin`, {
    method: "POST",
    body: JSON.stringify({ action: "start-full-audit", ...payload }),
  });
}

export function cancelArsenkinFullAudit(
  caseId: string,
  payload: ArsenkinUiActionPayload
): Promise<ArsenkinUiStatusDto & { cancelled?: boolean }> {
  return request(`/cases/${caseId}/orion-golden/arsenkin`, {
    method: "POST",
    body: JSON.stringify({ action: "cancel-full-audit", ...payload }),
  });
}

