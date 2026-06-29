/**
 * Core domain types for the Digital Profile Audit module.
 *
 * These are framework-agnostic TypeScript types that mirror the Prisma schema
 * (`prisma/schema.prisma`). They are the contract used across services, agents,
 * the report builder/renderer and the API layer.
 *
 * Evidence-first rule: anything that ends up in a report must point to evidence
 * via `EvidenceRef`. The LLM is never a source of fact.
 */

import type { AuditSummary } from "./audit-summary/types";

// ----------------------------------------------------------------------------
// Enums (string unions, kept in sync with prisma/schema.prisma)
// ----------------------------------------------------------------------------

export type CaseStatus =
  | "DRAFT"
  | "COLLECTING"
  | "REVIEW"
  | "REPORT_READY"
  | "CLOSED"
  | "ARCHIVED";

export type ConsentStatus =
  | "NOT_REQUIRED"
  | "PENDING"
  | "OBTAINED"
  | "REFUSED";

export type LawfulBasis =
  | "CONSENT"
  | "CONTRACT"
  | "LEGAL_OBLIGATION"
  | "LEGITIMATE_INTEREST"
  | "PUBLIC_INTEREST"
  | "VITAL_INTEREST";

export type AgentNameValue =
  | "GOOGLE_SEARCH"
  | "YANDEX_SEARCH"
  | "WIKIPEDIA"
  | "AI_PROFILE"
  | "COMPLIANCE_DATABASE"
  | "RISK_CLASSIFIER"
  | "REPORT_SYNTHESIS"
  | "SEARCH_SURFACES";

export type AgentRunStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export type SearchEngine = "GOOGLE" | "YANDEX" | "BING" | "OTHER";

export type QuerySource = "MANUAL" | "GENERATED";

export type ResultClassification =
  | "UNCLASSIFIED"
  | "RELEVANT"
  | "IRRELEVANT"
  | "ADVERSE_MEDIA"
  | "SOCIAL_PROFILE"
  | "CORPORATE"
  | "LEGAL"
  | "DUPLICATE";

export type EvidenceType =
  | "URL"
  | "SCREENSHOT"
  | "IMPORTED_FILE"
  | "DATABASE_RECORD";

export type RiskSeverity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type ReviewStatus = "PENDING" | "REVIEWED" | "DISMISSED";

export type DatabaseProvider =
  | "LEXISNEXIS"
  | "DOW_JONES"
  | "WORLD_CHECK"
  | "OTHER";

export type ImportMethod = "OFFICIAL_API" | "MANUAL_IMPORT";

export type ReportStatus = "DRAFT" | "IN_REVIEW" | "FINAL";

// ----------------------------------------------------------------------------
// Evidence (the backbone of the evidence-first model)
// ----------------------------------------------------------------------------

/**
 * A pointer to a single piece of evidence. Every claim in a report and every
 * risk finding / profile must reference at least one of these.
 */
export interface EvidenceRef {
  type: EvidenceType;
  /** Id of the underlying record (searchResultId, screenshotId, etc.). */
  refId?: string;
  /** Original URL where applicable. */
  url?: string;
  /** Storage key for screenshots / imported files (private storage). */
  storageKey?: string;
  /** Human-readable label shown in the report. */
  label?: string;
  /** When the evidence was captured/observed. */
  capturedAt?: string;
}

// ----------------------------------------------------------------------------
// 1. DigitalProfileCase
// ----------------------------------------------------------------------------

export interface DigitalProfileCase {
  id: string;
  caseNumber: string;
  title: string;
  status: CaseStatus;
  lawfulBasis: LawfulBasis | null;
  consentStatus: ConsentStatus;
  createdBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------------------------
// 2. SubjectProfile
// ----------------------------------------------------------------------------

export interface SubjectProfile {
  id: string;
  caseId: string;
  fullName: string;
  aliases: string[];
  dateOfBirth: string | null;
  nationality: string | null;
  country: string | null;
  emails: string[];
  phones: string[];
  identifiers: Record<string, unknown> | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------------------------
// 3. SearchQuery
// ----------------------------------------------------------------------------

export interface SearchQuery {
  id: string;
  caseId: string;
  engine: SearchEngine;
  queryText: string;
  source: QuerySource;
  createdBy: string | null;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// 4. SearchResult
// ----------------------------------------------------------------------------

export interface SearchResult {
  id: string;
  caseId: string;
  queryId: string | null;
  engine: SearchEngine;
  url: string;
  normalizedUrl: string;
  dedupHash: string;
  title: string | null;
  snippet: string | null;
  rank: number | null;
  classification: ResultClassification;
  reviewStatus: ReviewStatus;
  createdAt: string;
}

// ----------------------------------------------------------------------------
// 5. ScreenshotEvidence
// ----------------------------------------------------------------------------

export interface ScreenshotEvidence {
  id: string;
  caseId: string;
  resultId: string | null;
  storageKey: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number | null;
  sourceUrl: string | null;
  capturedAt: string;
  capturedBy: string | null;
  deletedAt: string | null;
  deletedBy: string | null;
}

// ----------------------------------------------------------------------------
// 6. RiskFinding
// ----------------------------------------------------------------------------

export interface RiskFinding {
  id: string;
  caseId: string;
  category: string;
  severity: RiskSeverity;
  title: string;
  summary: string | null;
  evidenceRefs: EvidenceRef[];
  reviewStatus: ReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ----------------------------------------------------------------------------
// 7. DatabaseProfile
// ----------------------------------------------------------------------------

export interface DatabaseProfile {
  id: string;
  caseId: string;
  provider: DatabaseProvider;
  importMethod: ImportMethod;
  matchType: string | null;
  matchScore: number | null;
  rawPayload: Record<string, unknown> | null;
  evidenceRefs: EvidenceRef[];
  importedBy: string | null;
  importedAt: string;
}

// ----------------------------------------------------------------------------
// 8. WikipediaCheck
// ----------------------------------------------------------------------------

export interface WikipediaCheck {
  id: string;
  caseId: string;
  exists: boolean;
  url: string | null;
  language: string | null;
  pageTitle: string | null;
  snapshot: Record<string, unknown> | null;
  lastChecked: string;
  checkedBy: string | null;
}

// ----------------------------------------------------------------------------
// 9. AiProfileResult
// ----------------------------------------------------------------------------

export interface AiProfileResult {
  id: string;
  caseId: string;
  model: string;
  summary: string | null;
  classifications: Record<string, unknown> | null;
  evidenceRefs: EvidenceRef[];
  disclaimer: string;
  createdAt: string;
  createdBy: string | null;
}

// ----------------------------------------------------------------------------
// 10. ReportJson  (single source of truth for the renderer)
// ----------------------------------------------------------------------------

export interface ReportPriceItem {
  code: string;
  label: string;
  amount: number;
  currency: string;
  note?: string;
}

export interface ReportMeta {
  caseNumber: string;
  title: string;
  generatedAt: string;
  version: number;
  status: ReportStatus;
  /** Watermark text; "DRAFT" until final review. Empty/undefined when FINAL. */
  watermark?: string;
  language: string;
}

/**
 * The complete, self-contained JSON consumed by the ReportRenderer.
 * Dynamic pages come from collected evidence; static commercial pages and
 * pricing are merged in from config/templates.
 */
export interface ReportRiskSummary {
  highestRiskLevel: string;
  totalFindings: number;
  findingsByLevel: Record<string, number>;
  findingsByTheme: Record<string, number>;
  topFindings: {
    severity: string;
    theme: string;
    title: string;
    evidenceCount: number;
  }[];
}

export interface ReportOfferSolution {
  key: string;
  title: string;
  subtitle: string;
  objective: string;
  price: number;
  currency: string;
  duration: string;
  includedItems: string[];
  deliverables: string[];
  expectedResults: string[];
  workPlan: string[];
  pricingNotes: string;
}

export interface ReportOffer {
  productName: string;
  solution1Title: string;
  solution1Price: number;
  solution2Title: string;
  solution2Price: number;
  solution3Title: string;
  solution3Price: number;
  currency: string;
  pricingNotes: string;
  companyName: string;
  contactEmail: string;
  website: string;
  // Stage K3 — structured commercial block (additive; v1/v2 use flat fields).
  brandName?: string;
  reportSubtitle?: string;
  companyDescription?: string;
  solutions?: ReportOfferSolution[];
  processSteps?: string[];
  callToAction?: string;
  disclaimers?: string[];
}

export interface ReportJson {
  meta: ReportMeta;
  subject: SubjectProfile;
  /** Ordered dynamic pages (person-specific). */
  dynamicPages: ReportPageData[];
  /** Static commercial pages (services offering), filled from templates. */
  staticPages: ReportPageData[];
  pricing: ReportPriceItem[];
  /** Stage I — aggregated risk summary (review-gated findings). */
  riskSummary?: ReportRiskSummary;
  /** Stage J — full deterministic audit summary (evidence-derived). */
  auditSummary?: AuditSummary;
  /** Stage C1 — compliance databases evidence layer summary. */
  complianceSummary?: import("./compliance-providers/types").ComplianceSummaryBlock;
  /** Stage K1 — commercial offer block (prices from config, never hardcoded). */
  offer?: ReportOffer;
  /** Stage L2 — language the report (PPTX/PDF) is rendered in. */
  reportLanguage?: "ru" | "en";
  /**
   * Stage S1 — reference to the latest synthetic ORION-style SERP snapshot, when
   * one exists. Additive + optional: the renderer/templates ignore unknown keys,
   * so this does not change the existing report layout.
   */
  serpSnapshot?: ReportSerpSnapshot;
}

/** Stage S1 — minimal SERP snapshot reference embedded in report_json. */
export interface ReportSerpSnapshot {
  /** Screenshot-row id of the snapshot (Stage S1.5). */
  id: string;
  storageKey: string;
  query: string;
  mode: "SYNTHETIC";
  /**
   * Stage S1.5 — render-time only. Base64-encoded PNG bytes injected by the
   * renderer service right before calling the (stateless) Python renderer so it
   * can embed the ORION-style page image. It is NEVER persisted in the stored
   * report_json (kept lightweight); the persisted value only carries the
   * storageKey reference. Optional so the stored reference stays small.
   */
  imageBase64?: string;
  metadata: {
    engines: string[];
    language: "ru" | "en";
    themeCount: number;
    highlightedCount: number;
    resultCount: number;
    width: number;
    height: number;
    generatedAt: string;
    /** Stage N1.2 — provenance of the underlying search_results. */
    sourceMode?: "MOCK_ONLY" | "REAL_ONLY" | "MIXED" | "EMPTY";
    /** Stage N1.2 — per-engine source breakdown. */
    perEngine?: {
      yandex: { sourceMode: "REAL" | "MOCK" | "EMPTY"; resultCount: number; highlightedCount: number };
      google: { sourceMode: "REAL" | "MOCK" | "EMPTY"; resultCount: number; highlightedCount: number };
    };
  };
}

// ----------------------------------------------------------------------------
// 11. ReportPageData
// ----------------------------------------------------------------------------

export type ReportPageKind =
  | "COVER"
  | "SUMMARY"
  | "SUBJECT"
  | "SEARCH_RESULTS"
  | "SCREENSHOTS"
  | "WIKIPEDIA"
  | "AI_PROFILE"
  | "COMPLIANCE_DATABASES"
  | "RISK_FINDINGS"
  | "STATIC_OFFER"
  | "STATIC_PRICING"
  | "STATIC_CONTACT";

export interface ReportTableData {
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface ReportImageData {
  storageKey?: string;
  url?: string;
  caption?: string;
  evidence?: EvidenceRef;
}

/**
 * A single renderable page. Maps to a PPTX slide (template placeholder set).
 * Dynamic pages must carry `evidence` for any factual blocks.
 */
export interface ReportPageData {
  kind: ReportPageKind;
  /** PPTX template/layout name to clone for this page. */
  templateSlide?: string;
  title?: string;
  subtitle?: string;
  body?: string[];
  table?: ReportTableData;
  images?: ReportImageData[];
  /** Evidence backing this page's factual content. */
  evidence?: EvidenceRef[];
  /** Whether this is a static (non-person-specific) commercial page. */
  isStatic?: boolean;
}

// ----------------------------------------------------------------------------
// Agent architecture
// ----------------------------------------------------------------------------

export interface AgentContext {
  caseId: string;
  /** Actor that triggered the run (for audit logging). */
  actorId: string;
  /** When true, agent must not hit external APIs (mock/manual mode). */
  mock?: boolean;
}

export interface SavedEvidenceSummary {
  searchResults?: number;
  searchSurfaceItems?: number;
  screenshots?: number;
  databaseProfiles?: number;
  wikipediaChecks?: number;
  aiProfiles?: number;
  riskFindings?: number;
}

export interface AgentRunResult {
  agentName: AgentNameValue;
  status: AgentRunStatus;
  /** Normalized, evidence-backed output payload. */
  output?: unknown;
  /** Count of evidence records persisted by this run. */
  saved: SavedEvidenceSummary;
  error?: string;
  startedAt: string;
  finishedAt: string;
}

/**
 * Common interface every collector/processor agent implements.
 *
 * Lifecycle: validateInput -> run -> normalizeOutput -> saveEvidence.
 * `run()` orchestrates the lifecycle and returns an AgentRunResult.
 */
export interface Agent<TRaw = unknown, TNormalized = unknown> {
  readonly name: AgentNameValue;

  /** Validate that the case has the inputs this agent needs. Throws on invalid. */
  validateInput(ctx: AgentContext): Promise<void>;

  /** Execute the agent for a case and return a run result. */
  run(ctx: AgentContext): Promise<AgentRunResult>;

  /** Transform raw collected data into normalized, evidence-tagged records. */
  normalizeOutput(raw: TRaw): Promise<TNormalized>;

  /** Persist normalized records as evidence and return how many were saved. */
  saveEvidence(
    ctx: AgentContext,
    normalized: TNormalized
  ): Promise<SavedEvidenceSummary>;
}
