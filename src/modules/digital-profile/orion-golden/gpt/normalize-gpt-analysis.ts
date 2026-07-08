/**
 * R10 — Normalize GPT section JSON into strict schema shape.
 */

import type { OrionGoldenGptSectionKey } from "./orion-section-analyzer";
import {
  sanitizeOrionGoldenClientText,
} from "../client/client-text-sanitizer";
import { normalizeInternalRiskMatrix, sanitizeExecutiveClientFields, mapInternalRiskLevel } from "../client/risk-matrix-normalizer";

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\n+/)
      .map((s) => s.replace(/^[-•*]\s*/, "").trim())
      .filter(Boolean);
  }
  return [];
}

function mapRiskLevel(value: unknown): "low" | "medium" | "high" | "critical" | "review_required" | "no_data" {
  const raw = String(value ?? "").toLowerCase();
  if (["low", "низк", "minimal"].some((k) => raw.includes(k))) return "low";
  if (["medium", "умерен", "moderate"].some((k) => raw.includes(k))) return "medium";
  if (["critical", "крит"].some((k) => raw.includes(k))) return "critical";
  if (["high", "повыш", "elevated"].some((k) => raw.includes(k))) return "high";
  if (["review", "провер", "manual"].some((k) => raw.includes(k))) return "review_required";
  if (["no_data", "нет данных", "nodata"].some((k) => raw.includes(k))) return "no_data";
  return "review_required";
}

function mapVerification(value: unknown): "confirmed" | "likely" | "requires_review" | "excluded_from_risk" {
  const raw = String(value ?? "").toLowerCase();
  if (raw.includes("confirm") || raw.includes("подтверж")) return "confirmed";
  if (raw.includes("likely") || raw.includes("вероят")) return "likely";
  if (raw.includes("exclude") || raw.includes("исключ")) return "excluded_from_risk";
  return "requires_review";
}

export function normalizeGoldenSectionAnalysis(
  raw: Record<string, unknown>,
  sectionKey: OrionGoldenGptSectionKey,
  fallbackTitle: string
): Record<string, unknown> {
  const keyEvidenceRaw = Array.isArray(raw.keyEvidence) ? raw.keyEvidence : [];
  const keyEvidence = keyEvidenceRaw.map((item, idx) => {
    const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    return {
      title: String(row.title ?? row.name ?? row.label ?? `Источник ${idx + 1}`),
      domain: row.domain ? String(row.domain) : undefined,
      sourceType: String(row.sourceType ?? row.type ?? row.source ?? "open_source"),
      whyRelevant: sanitizeOrionGoldenClientText(
        String(row.whyRelevant ?? row.summary ?? row.reason ?? "Требует контекстуальной проверки")
      ),
      verificationStatus: mapVerification(row.verificationStatus ?? row.status),
    };
  });

  const slidePlanRaw = Array.isArray(raw.slidePlan) ? raw.slidePlan : [];
  const slidePlan = slidePlanRaw.map((item, idx) => {
    const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const title = String(row.title ?? row.slideTitle ?? fallbackTitle);
    return {
      slideKey: String(row.slideKey ?? `${sectionKey}-slide-${idx + 1}`),
      template: String(row.template ?? "orion_golden_audit_dashboard"),
      title,
    };
  });

  if (slidePlan.length === 0) {
    slidePlan.push({
      slideKey: `${sectionKey}-summary`,
      template: "orion_golden_audit_dashboard",
      title: String(raw.clientTitle ?? fallbackTitle),
    });
  }

  return {
    sectionKey: String(raw.sectionKey ?? sectionKey),
    clientTitle: String(raw.clientTitle ?? fallbackTitle),
    mainConclusion: String(raw.mainConclusion ?? raw.summary ?? raw.conclusion ?? "Требуется дополнительная проверка."),
    riskLevel: mapRiskLevel(raw.riskLevel),
    whatWasChecked: asArray(raw.whatWasChecked),
    whatWasFound: asArray(raw.whatWasFound),
    whyItMatters: asArray(raw.whyItMatters),
    riskInterpretation: asArray(raw.riskInterpretation),
    manualReviewNeeded: asArray(raw.manualReviewNeeded),
    recommendedActions: asArray(raw.recommendedActions),
    keyEvidence,
    excludedNoiseSummary: asArray(raw.excludedNoiseSummary),
    clientNarrative: sanitizeOrionGoldenClientText(
      String(raw.clientNarrative ?? raw.narrative ?? raw.mainConclusion ?? "")
    ),
    slidePlan,
  };
}

export function normalizeExecutiveSynthesis(raw: Record<string, unknown>): Record<string, unknown> {
  const matrixRaw = Array.isArray(raw.riskMatrix) ? raw.riskMatrix : [];
  const riskMatrix = normalizeInternalRiskMatrix(
    matrixRaw.map((item) => {
      const row = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return {
        theme: String(row.theme ?? row.area ?? row.topic ?? "Риск"),
        level: String(row.level ?? row.riskLevel ?? "review_required"),
        summary: String(row.summary ?? row.description ?? ""),
      };
    })
  );

  const sanitized = sanitizeExecutiveClientFields({
    executiveSummary: String(raw.executiveSummary ?? raw.summary ?? ""),
    globalRiskLevel: (() => {
      const level = mapRiskLevel(raw.globalRiskLevel ?? raw.riskLevel);
      return level === "no_data" ? mapInternalRiskLevel("review_required") : mapInternalRiskLevel(level);
    })(),
    mainRisks: asArray(raw.mainRisks),
    possibleConsequences: asArray(raw.possibleConsequences),
    finalRecommendations: asArray(raw.finalRecommendations ?? raw.recommendations),
    nextSteps: asArray(raw.nextSteps),
  });

  return {
    executiveSummary: sanitized.executiveSummary,
    globalRiskLevel: sanitized.globalRiskLevel,
    riskMatrix,
    mainRisks: sanitized.mainRisks,
    possibleConsequences: sanitized.possibleConsequences,
    finalRecommendations: sanitized.finalRecommendations,
    nextSteps: sanitized.nextSteps,
  };
}
