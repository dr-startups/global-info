/**
 * R10.6a — Normalize GPT section analysis JSON into strict OrionSectionAnalysis shape.
 */

import type { OrionSectionAnalysisStatus } from "../sections/orion-section-analysis";

const VALID_STATUSES: OrionSectionAnalysisStatus[] = [
  "HAS_FINDINGS",
  "NO_FINDINGS",
  "DATA_POOR",
  "NOT_APPLICABLE",
  "MANUAL_REVIEW_PENDING",
];

const STATUS_ALIASES: Record<string, OrionSectionAnalysisStatus> = {
  has_findings: "HAS_FINDINGS",
  no_findings: "NO_FINDINGS",
  data_poor: "DATA_POOR",
  insufficient: "DATA_POOR",
  not_applicable: "NOT_APPLICABLE",
  na: "NOT_APPLICABLE",
  manual_review_pending: "MANUAL_REVIEW_PENDING",
  manual_review_required: "MANUAL_REVIEW_PENDING",
  review_required: "MANUAL_REVIEW_PENDING",
  pending_review: "MANUAL_REVIEW_PENDING",
  requires_review: "MANUAL_REVIEW_PENDING",
};

const CONFIDENCE_ALIASES: Record<string, "Высокая" | "Средняя" | "Низкая"> = {
  high: "Высокая",
  medium: "Средняя",
  low: "Низкая",
  высокая: "Высокая",
  средняя: "Средняя",
  низкая: "Низкая",
};

const LEVEL_ALIASES: Record<string, "Низкий" | "Средний" | "Высокий" | "Критический" | "Требует проверки"> = {
  low: "Низкий",
  medium: "Средний",
  high: "Высокий",
  critical: "Критический",
  review_required: "Требует проверки",
  requires_review: "Требует проверки",
  низкий: "Низкий",
  средний: "Средний",
  высокий: "Высокий",
  критический: "Критический",
};

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function mapStatus(raw: unknown): OrionSectionAnalysisStatus {
  const normalized = String(raw ?? "DATA_POOR")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (VALID_STATUSES.includes(normalized as OrionSectionAnalysisStatus)) {
    return normalized as OrionSectionAnalysisStatus;
  }
  const alias = STATUS_ALIASES[normalized.toLowerCase()];
  if (alias) return alias;
  if (normalized.includes("MANUAL") || normalized.includes("REVIEW") || normalized.includes("PENDING")) {
    return "MANUAL_REVIEW_PENDING";
  }
  if (normalized.includes("NO_FIND") || normalized.includes("CLEAR")) return "NO_FINDINGS";
  if (normalized.includes("NOT_APPLIC") || normalized.includes("N_A")) return "NOT_APPLICABLE";
  if (normalized.includes("INSUFF") || normalized.includes("POOR") || normalized.includes("LIMITED")) {
    return "DATA_POOR";
  }
  if (normalized.includes("FIND")) return "HAS_FINDINGS";
  return "DATA_POOR";
}

function mapConfidence(raw: unknown): "Высокая" | "Средняя" | "Низкая" {
  const key = String(raw ?? "Средняя").trim().toLowerCase();
  if (CONFIDENCE_ALIASES[key]) return CONFIDENCE_ALIASES[key]!;
  const direct = String(raw ?? "");
  if (["Высокая", "Средняя", "Низкая"].includes(direct)) return direct as "Высокая" | "Средняя" | "Низкая";
  return "Средняя";
}

function mapRiskLevel(raw: unknown): "Низкий" | "Средний" | "Высокий" | "Критический" | "Требует проверки" {
  const key = String(raw ?? "Требует проверки").trim().toLowerCase();
  if (LEVEL_ALIASES[key]) return LEVEL_ALIASES[key]!;
  const direct = String(raw ?? "");
  if (["Низкий", "Средний", "Высокий", "Критический", "Требует проверки"].includes(direct)) {
    return direct as "Низкий" | "Средний" | "Высокий" | "Критический" | "Требует проверки";
  }
  return "Требует проверки";
}

function normalizeKeyFindings(raw: unknown): Array<{
  title: string;
  summary: string;
  evidenceRefs: string[];
  confidence: "Высокая" | "Средняя" | "Низкая";
  caveat?: string;
}> {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, idx) => {
      if (typeof item === "string") {
        return {
          title: `Вывод ${idx + 1}`,
          summary: item,
          evidenceRefs: [],
          confidence: "Средняя" as const,
        };
      }
      const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      const evidenceId = String(row.evidenceId ?? row.evidence_id ?? row.id ?? "").trim();
      const evidenceRefs = Array.isArray(row.evidenceRefs)
        ? row.evidenceRefs.map(String).filter(Boolean)
        : evidenceId
          ? [evidenceId]
          : [];
      const title = String(row.title ?? row.finding ?? row.name ?? row.label ?? `Вывод ${idx + 1}`).trim();
      const summary = String(
        row.summary ?? row.assessment ?? row.description ?? row.finding ?? row.text ?? title
      ).trim();
      const caveat = row.caveat ? String(row.caveat) : row.requiresManualReview ? "Требует ручной проверки" : undefined;
      return {
        title: title || `Вывод ${idx + 1}`,
        summary: summary || title,
        evidenceRefs,
        confidence: mapConfidence(row.confidence),
        caveat,
      };
    })
    .filter((f) => f.title || f.summary);
}

function normalizeRisks(raw: unknown): Array<{
  theme: string;
  level: "Низкий" | "Средний" | "Высокий" | "Критический" | "Требует проверки";
  summary: string;
  evidenceRefs: string[];
  requiresManualReview: boolean;
}> {
  if (!Array.isArray(raw)) return [];
  return raw.map((item, idx) => {
    if (typeof item === "string") {
      return {
        theme: `Риск ${idx + 1}`,
        level: "Требует проверки" as const,
        summary: item,
        evidenceRefs: [],
        requiresManualReview: true,
      };
    }
    const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const evidenceId = String(row.evidenceId ?? row.evidence_id ?? "").trim();
    const evidenceRefs = Array.isArray(row.evidenceRefs)
      ? row.evidenceRefs.map(String).filter(Boolean)
      : evidenceId
        ? [evidenceId]
        : [];
    const theme = String(row.theme ?? row.area ?? row.topic ?? row.title ?? `Риск ${idx + 1}`).trim();
    const summary = String(row.summary ?? row.description ?? row.text ?? theme).trim();
    const requiresManualReview = Boolean(
      row.requiresManualReview ?? row.manualReview ?? row.requires_review ?? summary.toLowerCase().includes("проверк")
    );
    return {
      theme: theme || `Риск ${idx + 1}`,
      level: mapRiskLevel(row.level ?? row.riskLevel ?? row.severity),
      summary: summary || theme,
      evidenceRefs,
      requiresManualReview,
    };
  });
}

export function normalizeSectionAnalysis(raw: Record<string, unknown>, sectionId: string): Record<string, unknown> {
  return {
    sectionId: String(raw.sectionId ?? sectionId),
    status: mapStatus(raw.status),
    clientNarrative: String(raw.clientNarrative ?? raw.narrative ?? raw.summary ?? "Данных недостаточно для выводов."),
    keyFindings: normalizeKeyFindings(raw.keyFindings ?? raw.findings ?? raw.key_findings),
    risks: normalizeRisks(raw.risks ?? raw.riskItems ?? raw.risk_items),
    limitations: asStringArray(raw.limitations ?? raw.limitation),
    recommendations: asStringArray(raw.recommendations ?? raw.recommendation),
  };
}
