/**
 * Stage R3.5 — Compliance / Risk Intelligence normalization (display-level only).
 *
 * This module DOES NOT collect data, call providers, or change scoring. It takes
 * already-built report blocks (compliance summary, risk summary, evidence quality,
 * entity filtering) and produces a normalized, client-safe display model:
 *
 *   - consistent review/confirmed/excluded semantics
 *   - manual-import-aware wording (manual != automatically confirmed)
 *   - LOW/MEDIUM/HIGH mapping that never implies guilt/liability
 *   - centralized client-safe legal wording (RU + EN)
 *
 * Internal-only fields (e.g. internalReason) are stripped for the client audience
 * by report-data-policy.
 */

import type { ComplianceSummaryBlock } from "../compliance-providers/types";
import type { ReportRiskSummary } from "../types";
import type { EvidenceQualitySummary } from "../evidence-quality/types";

export type IntelLang = "ru" | "en";

export type IntelRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";

export type IntelReviewState = "confirmed" | "review" | "excluded" | "pending";

export type IntelSourceKind = "real" | "manual" | "mock" | "unknown";

export interface ComplianceIntelHit {
  sourceLabel: string;
  sourceKind: IntelSourceKind;
  matchTitle: string;
  matchType: string;
  riskLevel: IntelRiskLevel;
  reviewState: IntelReviewState;
  reviewStatusLabel: string;
  confidenceLabel: string;
  actionLabel: string;
  clientSafeSummary: string;
  /** Internal-only; sanitized out for client audience. */
  internalReason?: string;
  isClientVisible: boolean;
  isConfirmed: boolean;
  requiresReview: boolean;
  isExcludedNoise: boolean;
  isManualImport: boolean;
}

export interface RiskReasoningIntel {
  riskLevel: IntelRiskLevel;
  riskLevelLabel: string;
  region: string;
  evidenceCount: number;
  confirmedCount: number;
  reviewCount: number;
  excludedCount: number;
  mediaSignals: number;
  complianceSignals: number;
  organicSignals: number;
  reasoningSummary: string;
  limitingFactors: string[];
  recommendedAction: string;
  legalSafeDisclaimer: string;
}

export interface ManualImportSemantics {
  total: number;
  confirmed: number;
  review: number;
  excluded: number;
  note: string;
}

export interface ComplianceRiskIntel {
  enabled: true;
  language: IntelLang;
  counts: {
    confirmed: number;
    review: number;
    excluded: number;
    total: number;
  };
  complianceHits: ComplianceIntelHit[];
  riskReasoning: RiskReasoningIntel;
  manualImport: ManualImportSemantics;
  lexisNexisHybridSummary?: string;
  legalSafeDisclaimer: string;
}

// ---------------------------------------------------------------------------
// client-safe wording (RU + EN) — single source of truth for R3.5
// ---------------------------------------------------------------------------

interface IntelLabelSet {
  riskLow: string;
  riskMedium: string;
  riskHigh: string;
  riskUnknown: string;
  reviewConfirmed: string;
  reviewReview: string;
  reviewExcluded: string;
  reviewPending: string;
  actionConfirmed: string;
  actionReview: string;
  actionExcluded: string;
  summaryConfirmed: string;
  summaryReview: string;
  summaryExcluded: string;
  summaryManualReview: string;
  sourceManual: string;
  sourceReal: string;
  sourceMock: string;
  sourceUnknown: string;
  confidenceLow: string;
  confidenceMedium: string;
  confidenceHigh: string;
  confidenceUnknown: string;
  lowNoConfirmed: string;
  reasoningConfirmed: string;
  reasoningReviewOnly: string;
  reasoningNoData: string;
  limitManualReview: string;
  limitPendingReview: string;
  limitCoverage: string;
  recommendedMonitor: string;
  recommendedReview: string;
  recommendedProceed: string;
  legalSafeDisclaimer: string;
  manualNote: string;
}

const LABELS: Record<IntelLang, IntelLabelSet> = {
  ru: {
    riskLow: "Низкий",
    riskMedium: "Средний",
    riskHigh: "Высокий",
    riskUnknown: "Не определён",
    reviewConfirmed: "Подтверждено",
    reviewReview: "Требует проверки",
    reviewExcluded: "Исключено как нерелевантное совпадение",
    reviewPending: "Требует аналитической проверки",
    actionConfirmed: "Проверка источника перед использованием",
    actionReview: "Требуется аналитическая проверка",
    actionExcluded: "Исключено",
    summaryConfirmed:
      "Подтверждённое совпадение по источнику; материалы требуют проверки перед использованием в юридически значимых решениях.",
    summaryReview:
      "Предварительный сигнал — совпадение не подтверждено и требует аналитической проверки.",
    summaryExcluded: "Исключено как нерелевантное совпадение.",
    summaryManualReview:
      "Материал загружен вручную и требует проверки; не является подтверждённым выводом.",
    sourceManual: "Ручной импорт",
    sourceReal: "Официальный источник",
    sourceMock: "Демонстрационные данные",
    sourceUnknown: "Проверка источника",
    confidenceLow: "Низкая",
    confidenceMedium: "Средняя",
    confidenceHigh: "Высокая",
    confidenceUnknown: "—",
    lowNoConfirmed:
      "По доступным данным подтверждённых материалов высокого риска не выявлено.",
    reasoningConfirmed:
      "Итоговый уровень риска отражает подтверждённые сигналы по доступным данным.",
    reasoningReviewOnly:
      "Часть сигналов требует аналитической проверки и пока не учитывается как подтверждённый вывод.",
    reasoningNoData:
      "По доступным данным существенных подтверждённых сигналов не выявлено.",
    limitManualReview:
      "Материалы ручного импорта требуют проверки перед интерпретацией.",
    limitPendingReview:
      "Часть материалов находится в очереди аналитической проверки.",
    limitCoverage:
      "Выводы отражают доступный на момент отчёта объём данных и требуют периодической актуализации.",
    recommendedMonitor:
      "Рекомендуется периодический мониторинг открытых источников.",
    recommendedReview:
      "Рекомендуется аналитическая проверка материалов перед использованием.",
    recommendedProceed:
      "Критичных ограничений не выявлено; сохраняется стандартная процедура проверки.",
    legalSafeDisclaimer:
      "Материалы являются аналитической сводкой и требуют проверки перед использованием в юридически значимых решениях.",
    manualNote:
      "Материалы ручного импорта отражаются как источник и не являются автоматически подтверждённым выводом.",
  },
  en: {
    riskLow: "Low",
    riskMedium: "Medium",
    riskHigh: "High",
    riskUnknown: "Not determined",
    reviewConfirmed: "Confirmed",
    reviewReview: "Requires review",
    reviewExcluded: "Excluded as an irrelevant match",
    reviewPending: "Requires analyst review",
    actionConfirmed: "Verify the source before use",
    actionReview: "Requires analyst review",
    actionExcluded: "Excluded",
    summaryConfirmed:
      "Confirmed match against the source; materials require verification before use in legally significant decisions.",
    summaryReview:
      "Preliminary signal — the match is not confirmed and requires analyst review.",
    summaryExcluded: "Excluded as an irrelevant match.",
    summaryManualReview:
      "Manually imported material that requires review; it is not a confirmed conclusion.",
    sourceManual: "Manual import",
    sourceReal: "Official source",
    sourceMock: "Demonstration data",
    sourceUnknown: "Source verification",
    confidenceLow: "Low",
    confidenceMedium: "Medium",
    confidenceHigh: "High",
    confidenceUnknown: "—",
    lowNoConfirmed:
      "No confirmed high-risk materials were found in the available data.",
    reasoningConfirmed:
      "The overall risk level reflects confirmed signals across the available data.",
    reasoningReviewOnly:
      "Some signals require analyst review and are not yet counted as a confirmed conclusion.",
    reasoningNoData:
      "No material confirmed signals were found in the available data.",
    limitManualReview:
      "Manually imported materials require review before interpretation.",
    limitPendingReview: "Some materials are in the analyst review queue.",
    limitCoverage:
      "Findings reflect the data available at report time and should be refreshed periodically.",
    recommendedMonitor: "Periodic open-source monitoring is recommended.",
    recommendedReview:
      "Analyst review of the materials is recommended before use.",
    recommendedProceed:
      "No critical limitations were found; the standard verification procedure applies.",
    legalSafeDisclaimer:
      "The materials are an analytical summary and require verification before use in legally significant decisions.",
    manualNote:
      "Manually imported materials are shown as a source and are not automatically a confirmed conclusion.",
  },
};

/**
 * Legal-overclaiming / raw-enum terms that must never reach client wording.
 * Used by the R3.5 smoke test to guard the client-safe label set.
 */
export const FORBIDDEN_CLIENT_TERMS: RegExp[] = [
  /\bcriminal\b/i,
  /\bguilty\b/i,
  /\billegal\b/i,
  /\bfraudster\b/i,
  /\bproven\b/i,
  /\bsanctioned person\b/i,
  /\bпреступник/i,
  /\bвиновен/i,
  /\bмошенник/i,
  /\bдоказан/i,
  /WARN_POTENTIAL_REVIEW/,
  /UNCLASSIFIED/,
  /LIKELY_SUBJECT/,
  /NOT_SUBJECT/,
  /MATCH_CONFIRMED/,
  /FALSE_POSITIVE/,
];

export function containsForbiddenClientTerm(text: string): boolean {
  return FORBIDDEN_CLIENT_TERMS.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// normalization helpers
// ---------------------------------------------------------------------------

function riskLevelFromScore(score: number | null | undefined): IntelRiskLevel {
  if (score == null) return "UNKNOWN";
  if (score >= 80) return "HIGH";
  if (score >= 50) return "MEDIUM";
  if (score > 0) return "LOW";
  return "UNKNOWN";
}

function normalizeRiskLevel(raw: string | null | undefined): IntelRiskLevel {
  const s = String(raw ?? "").toUpperCase();
  if (s.includes("CRITICAL") || s.includes("HIGH")) return "HIGH";
  if (s.includes("MEDIUM") || s.includes("MODERATE")) return "MEDIUM";
  if (s.includes("LOW")) return "LOW";
  return "UNKNOWN";
}

function riskLevelLabel(level: IntelRiskLevel, L: IntelLabelSet): string {
  switch (level) {
    case "HIGH":
      return L.riskHigh;
    case "MEDIUM":
      return L.riskMedium;
    case "LOW":
      return L.riskLow;
    default:
      return L.riskUnknown;
  }
}

/** Map raw compliance review status -> client-safe review state. */
export function normalizeReviewState(raw: string | null | undefined): IntelReviewState {
  const s = String(raw ?? "PENDING").toUpperCase();
  if (s === "MATCH_CONFIRMED") return "confirmed";
  if (s === "FALSE_POSITIVE" || s === "DISMISSED") return "excluded";
  if (s === "NEEDS_REVIEW" || s === "PENDING") return "review";
  return "review";
}

function reviewStateLabel(state: IntelReviewState, L: IntelLabelSet): string {
  switch (state) {
    case "confirmed":
      return L.reviewConfirmed;
    case "excluded":
      return L.reviewExcluded;
    case "pending":
      return L.reviewPending;
    default:
      return L.reviewReview;
  }
}

function sourceKindFrom(source: string | null | undefined, provider: string | null | undefined): IntelSourceKind {
  const s = `${String(source ?? "")} ${String(provider ?? "")}`.toUpperCase();
  if (s.includes("MANUAL")) return "manual";
  if (s.includes("MOCK")) return "mock";
  if (s.includes("OFFICIAL") || s.includes("REAL") || s.includes("API")) return "real";
  return "unknown";
}

function sourceLabel(kind: IntelSourceKind, L: IntelLabelSet): string {
  switch (kind) {
    case "manual":
      return L.sourceManual;
    case "real":
      return L.sourceReal;
    case "mock":
      return L.sourceMock;
    default:
      return L.sourceUnknown;
  }
}

function confidenceLabel(raw: string | null | undefined, L: IntelLabelSet): string {
  const s = String(raw ?? "").toUpperCase();
  if (s === "HIGH") return L.confidenceHigh;
  if (s === "MEDIUM") return L.confidenceMedium;
  if (s === "LOW") return L.confidenceLow;
  return L.confidenceUnknown;
}

function normalizeHit(
  hit: ComplianceSummaryBlock["topHits"][number],
  L: IntelLabelSet
): ComplianceIntelHit {
  const kind = sourceKindFrom(hit.source, hit.provider);
  const isManual = kind === "manual";
  const state = normalizeReviewState(hit.reviewStatus);
  const riskLevel = riskLevelFromScore(hit.matchScore);
  const isConfirmed = state === "confirmed";
  const isExcludedNoise = state === "excluded";
  const requiresReview = state === "review" || state === "pending";

  let clientSafeSummary: string;
  let actionLabel: string;
  if (isExcludedNoise) {
    clientSafeSummary = L.summaryExcluded;
    actionLabel = L.actionExcluded;
  } else if (isConfirmed) {
    clientSafeSummary = L.summaryConfirmed;
    actionLabel = L.actionConfirmed;
  } else if (isManual) {
    clientSafeSummary = L.summaryManualReview;
    actionLabel = L.actionReview;
  } else {
    clientSafeSummary = L.summaryReview;
    actionLabel = L.actionReview;
  }

  return {
    sourceLabel: sourceLabel(kind, L),
    sourceKind: kind,
    matchTitle: String(hit.matchedName || "—"),
    matchType: (hit.riskTypes ?? []).join(", ") || "—",
    riskLevel,
    reviewState: state,
    reviewStatusLabel: reviewStateLabel(state, L),
    confidenceLabel: confidenceLabel(hit.confidence, L),
    actionLabel,
    clientSafeSummary,
    internalReason: `raw_review=${String(hit.reviewStatus ?? "PENDING")}; raw_source=${String(hit.source ?? "")}; score=${hit.matchScore ?? "n/a"}`,
    isClientVisible: !isExcludedNoise,
    isConfirmed,
    requiresReview,
    isExcludedNoise,
    isManualImport: isManual,
  };
}

function buildRiskReasoning(
  compliance: ComplianceSummaryBlock | undefined,
  risk: ReportRiskSummary | undefined,
  evidence: EvidenceQualitySummary | undefined,
  hits: ComplianceIntelHit[],
  L: IntelLabelSet
): RiskReasoningIntel {
  const riskLevel = normalizeRiskLevel(risk?.highestRiskLevel);
  const confirmedCount = hits.filter((h) => h.isConfirmed).length;
  const reviewCount = hits.filter((h) => h.requiresReview).length;
  const excludedCount = hits.filter((h) => h.isExcludedNoise).length;
  const complianceSignals = Number(compliance?.totalHits ?? hits.length) || 0;
  const totals = (evidence?.totals ?? {}) as Record<string, number>;
  const mediaSignals = Number(totals.mediaClientVisible ?? totals.media ?? 0) || 0;
  const organicSignals = Number(risk?.totalFindings ?? 0) || 0;
  const evidenceCount = confirmedCount + reviewCount + excludedCount;

  let reasoningSummary: string;
  if (riskLevel === "LOW" || riskLevel === "UNKNOWN") {
    reasoningSummary = L.lowNoConfirmed;
  } else if (confirmedCount > 0) {
    reasoningSummary = L.reasoningConfirmed;
  } else if (reviewCount > 0) {
    reasoningSummary = L.reasoningReviewOnly;
  } else {
    reasoningSummary = L.reasoningNoData;
  }

  const limitingFactors: string[] = [];
  if (hits.some((h) => h.isManualImport && h.requiresReview)) {
    limitingFactors.push(L.limitManualReview);
  }
  if (reviewCount > 0) {
    limitingFactors.push(L.limitPendingReview);
  }
  limitingFactors.push(L.limitCoverage);

  let recommendedAction: string;
  if (riskLevel === "HIGH" || confirmedCount > 0) {
    recommendedAction = L.recommendedReview;
  } else if (reviewCount > 0) {
    recommendedAction = L.recommendedReview;
  } else if (riskLevel === "MEDIUM") {
    recommendedAction = L.recommendedMonitor;
  } else {
    recommendedAction = L.recommendedProceed;
  }

  return {
    riskLevel,
    riskLevelLabel: riskLevelLabel(riskLevel, L),
    region: "overall",
    evidenceCount,
    confirmedCount,
    reviewCount,
    excludedCount,
    mediaSignals,
    complianceSignals,
    organicSignals,
    reasoningSummary,
    limitingFactors: limitingFactors.slice(0, 4),
    recommendedAction,
    legalSafeDisclaimer: L.legalSafeDisclaimer,
  };
}

export interface BuildComplianceRiskIntelInput {
  complianceSummary?: ComplianceSummaryBlock;
  riskSummary?: ReportRiskSummary;
  evidenceQuality?: EvidenceQualitySummary;
  reportLanguage?: IntelLang;
  lexisNexisHybrid?: {
    parsedSignalSummary?: { totalDocuments?: number; totalSignals?: number; reviewRequired?: number };
  };
}

export function buildComplianceRiskIntel(
  input: BuildComplianceRiskIntelInput
): ComplianceRiskIntel {
  const language: IntelLang = input.reportLanguage === "en" ? "en" : "ru";
  const L = LABELS[language];
  const topHits = input.complianceSummary?.topHits ?? [];
  const complianceHits = topHits.map((h) => normalizeHit(h, L));

  const confirmed = complianceHits.filter((h) => h.isConfirmed).length;
  const review = complianceHits.filter((h) => h.requiresReview).length;
  const excluded = complianceHits.filter((h) => h.isExcludedNoise).length;

  const manualHits = complianceHits.filter((h) => h.isManualImport);
  const manualImport: ManualImportSemantics = {
    total: manualHits.length,
    confirmed: manualHits.filter((h) => h.isConfirmed).length,
    review: manualHits.filter((h) => h.requiresReview).length,
    excluded: manualHits.filter((h) => h.isExcludedNoise).length,
    note: L.manualNote,
  };

  const riskReasoning = buildRiskReasoning(
    input.complianceSummary,
    input.riskSummary,
    input.evidenceQuality,
    complianceHits,
    L
  );
  const lexisSummary = input.lexisNexisHybrid?.parsedSignalSummary;
  const lexisNexisHybridSummary =
    lexisSummary && Number(lexisSummary.totalDocuments ?? 0) > 0
      ? language === "ru"
        ? `Импортированный отчёт LexisNexis: документов ${Number(
            lexisSummary.totalDocuments ?? 0
          )}, сигналов ${Number(lexisSummary.totalSignals ?? 0)}, на проверке ${Number(
            lexisSummary.reviewRequired ?? 0
          )}.`
        : `Imported LexisNexis report: documents ${Number(
            lexisSummary.totalDocuments ?? 0
          )}, signals ${Number(lexisSummary.totalSignals ?? 0)}, review required ${Number(
            lexisSummary.reviewRequired ?? 0
          )}.`
      : undefined;

  return {
    enabled: true,
    language,
    counts: {
      confirmed,
      review,
      excluded,
      total: complianceHits.length,
    },
    complianceHits,
    riskReasoning,
    manualImport,
    lexisNexisHybridSummary,
    legalSafeDisclaimer: L.legalSafeDisclaimer,
  };
}

/** Client-safe subset: drop excluded/noise hits and internal-only fields. */
export function sanitizeComplianceRiskIntelForClient(
  intel: ComplianceRiskIntel | undefined
): ComplianceRiskIntel | undefined {
  if (!intel) return intel;
  const clientHits = intel.complianceHits
    .filter((h) => h.isClientVisible)
    .map((h) => {
      const { internalReason: _internalReason, ...rest } = h;
      return rest as ComplianceIntelHit;
    });
  return {
    ...intel,
    complianceHits: clientHits,
  };
}
