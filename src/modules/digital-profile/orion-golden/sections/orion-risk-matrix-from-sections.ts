/**
 * R10.6 — Section-derived risk matrix (no raw inventory scan).
 */

import type { OrionSectionAnalysis } from "./orion-section-analysis";
import type { OrionSectionBundle } from "./orion-section-bundle";

export type SectionDerivedRiskMatrix = {
  version: "r10-6-risk-matrix-section-derived-v1";
  generatedAt: string;
  caseId: string;
  globalRiskLevel: "Низкий" | "Средний" | "Высокий" | "Критический" | "Требует проверки";
  rows: Array<{
    theme: string;
    level: "Низкий" | "Средний" | "Высокий" | "Критический" | "Требует проверки";
    summary: string;
    evidenceRefs: string[];
    sourceSectionIds: string[];
    requiresManualReview: boolean;
    caveat?: string;
  }>;
  pendingManualReviewCount: number;
  inputSource: "section_analyses_only";
};

function maxLevel(
  levels: Array<SectionDerivedRiskMatrix["rows"][0]["level"]>
): SectionDerivedRiskMatrix["globalRiskLevel"] {
  const order = ["Низкий", "Средний", "Высокий", "Критический", "Требует проверки"] as const;
  let maxIdx = 0;
  for (const l of levels) {
    const idx = order.indexOf(l);
    if (idx > maxIdx) maxIdx = idx;
  }
  return order[maxIdx] ?? "Средний";
}

export function buildRiskMatrixFromSections(input: {
  caseId: string;
  sectionAnalyses: OrionSectionAnalysis[];
  sectionBundles?: OrionSectionBundle[];
}): SectionDerivedRiskMatrix {
  const rowMap = new Map<string, SectionDerivedRiskMatrix["rows"][0]>();

  for (const analysis of input.sectionAnalyses) {
    for (const risk of analysis.risks) {
      const key = `${risk.theme}::${risk.level}`;
      const existing = rowMap.get(key);
      if (existing) {
        existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...risk.evidenceRefs])];
        existing.sourceSectionIds = [...new Set([...existing.sourceSectionIds, analysis.sectionId])];
        continue;
      }
      rowMap.set(key, {
        theme: risk.theme,
        level: risk.level,
        summary: risk.summary,
        evidenceRefs: [...risk.evidenceRefs],
        sourceSectionIds: [analysis.sectionId],
        requiresManualReview: risk.requiresManualReview,
      });
    }

    for (const finding of analysis.keyFindings) {
      if (!finding.caveat && finding.confidence !== "Низкая") continue;
      const key = `finding::${finding.title.slice(0, 40)}`;
      rowMap.set(key, {
        theme: finding.title.slice(0, 80),
        level: finding.caveat ? "Требует проверки" : "Средний",
        summary: finding.summary,
        evidenceRefs: finding.evidenceRefs,
        sourceSectionIds: [analysis.sectionId],
        requiresManualReview: Boolean(finding.caveat),
        caveat: finding.caveat,
      });
    }
  }

  if (input.sectionBundles) {
    const manualBundle = input.sectionBundles.find((b) => b.sectionId === "50_manual_review_required");
    if (manualBundle && manualBundle.allowedEvidence.length > 0) {
      rowMap.set("manual-review-pending", {
        theme: "Материалы на ручной проверке",
        level: "Требует проверки",
        summary: `${manualBundle.allowedEvidence.length} материал(ов) ожидают решения аналитика.`,
        evidenceRefs: manualBundle.allowedEvidence.slice(0, 20).map((e) => e.evidenceId),
        sourceSectionIds: ["50_manual_review_required"],
        requiresManualReview: true,
        caveat: "Не подтверждено автоматически",
      });
    }
  }

  const rows = [...rowMap.values()];
  const pendingManualReviewCount =
    input.sectionBundles?.find((b) => b.sectionId === "50_manual_review_required")?.allowedEvidence.length ?? 0;

  return {
    version: "r10-6-risk-matrix-section-derived-v1",
    generatedAt: new Date().toISOString(),
    caseId: input.caseId,
    globalRiskLevel: rows.length ? maxLevel(rows.map((r) => r.level)) : pendingManualReviewCount > 0 ? "Требует проверки" : "Низкий",
    rows,
    pendingManualReviewCount,
    inputSource: "section_analyses_only",
  };
}
