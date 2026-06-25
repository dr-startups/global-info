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
  lastChecked: string;
}

export interface RiskFinding {
  id: string;
  category: string;
  severity: string;
  title: string;
  summary: string | null;
  evidenceRefs: EvidenceRef[];
  reviewStatus: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface CaseEvidence {
  searchQueries: SearchQuery[];
  searchResults: SearchResult[];
  screenshots: Screenshot[];
  databaseProfiles: DatabaseProfile[];
  wikipediaChecks: WikipediaCheck[];
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
}

export interface AddSearchResultInput {
  engine: string;
  url: string;
  title?: string;
  classification?: string;
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

export function renderReport(caseId: string): Promise<RenderedReport> {
  return request<RenderedReport>(`/cases/${caseId}/report/render`, {
    method: "POST",
  });
}
