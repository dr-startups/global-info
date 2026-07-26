/**
 * R10.6 — Build ORION section bundles from gated evidence.
 */

import type { AdminReviewDecision } from "../evidence/admin-review-decision";
import { applyAdminDecisionsToJudgments } from "../evidence/apply-admin-decisions-to-judgments";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { ManualReviewQueue } from "../evidence/manual-review-queue";
import type { RawInventoryItem } from "../types";
import {
  getClientAuditSections,
  type OrionSectionRegistryEntry,
} from "./orion-section-registry";
import type {
  OrionSectionBundle,
  OrionSectionBundleEvidence,
  OrionSectionClientUse,
  OrionSectionDataSufficiency,
} from "./orion-section-bundle";

export type OrionSectionBundleBuilderInput = {
  caseInfo: {
    caseId: string;
    reportRunId: string;
    subjectName: string;
    aliases: string[];
  };
  inventory: FullEvidenceInventory;
  judgments: EvidenceJudgment[];
  manualQueue: ManualReviewQueue;
  adminDecisions: AdminReviewDecision[];
  regionSettings?: { ruEnabled?: boolean; uaeEnabled?: boolean };
};

function domainOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function hay(item: RawInventoryItem): string {
  return [item.title, item.snippet, item.sourceUrl, item.provider, item.evidenceType]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isRuRegion(region: string): boolean {
  const r = region.toUpperCase();
  return r !== "UAE" && r !== "INTL";
}

function isUaeRegion(region: string): boolean {
  const r = region.toUpperCase();
  return r === "UAE" || r === "INTL";
}

function providerHint(text: string, provider: string): "yandex" | "google" | "other" {
  const p = `${provider} ${text}`.toLowerCase();
  if (/yandex|яндекс/.test(p)) return "yandex";
  if (/google/.test(p)) return "google";
  return "other";
}

function resolveClientUse(j: EvidenceJudgment, sectionId: string): OrionSectionClientUse | null {
  if (j.reviewDecision === "EXCLUDE_WRONG_SUBJECT" || j.reviewDecision === "EXCLUDE_NOISE") return null;
  if (j.subjectBinding === "WRONG_SUBJECT") return null;

  if (sectionId === "50_manual_review_required") {
    if (j.reviewDecision === "MANUAL_REVIEW_REQUIRED" || j.adminReviewStatus === "NEEDS_MORE_SOURCES") {
      return "MANUAL_REVIEW_ONLY";
    }
    return null;
  }

  if (sectionId === "54_evidence_appendix") {
    if (j.reviewDecision === "APPENDIX_ONLY" || j.adminReviewStatus === "APPENDIX_ONLY") return "APPENDIX_ONLY";
    if (j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT" && j.adminReviewStatus === "APPROVED_WITH_CAVEAT") {
      return "APPENDIX_ONLY";
    }
    // R10.7b — WEAK/UNKNOWN may appear in appendix only
    if (j.subjectBinding === "WEAK" || j.subjectBinding === "UNKNOWN") return "APPENDIX_ONLY";
    return null;
  }

  if (sectionId === "51_excluded_noise_summary") return null;

  if (j.adminReviewStatus === "EXCLUDED" || j.adminReviewStatus === "WRONG_SUBJECT") return null;

  // R10.7b — WEAK/UNKNOWN never feed MAIN_ANALYSIS analytical sections
  if (
    (j.subjectBinding === "WEAK" || j.subjectBinding === "UNKNOWN") &&
    sectionId !== "50_manual_review_required" &&
    sectionId !== "52_limitations" &&
    sectionId !== "54_evidence_appendix"
  ) {
    if (j.reviewDecision === "MANUAL_REVIEW_REQUIRED") return "CAVEATED_ANALYSIS";
    return null;
  }

  if (j.reviewDecision === "MANUAL_REVIEW_REQUIRED" && j.adminReviewStatus === "PENDING") {
    if (sectionId === "50_manual_review_required" || sectionId === "52_limitations") {
      return "MANUAL_REVIEW_ONLY";
    }
    if (sectionId === "51_excluded_noise_summary" || sectionId === "54_evidence_appendix") return null;
    return "CAVEATED_ANALYSIS";
  }
  if (j.adminReviewStatus === "NEEDS_MORE_SOURCES") {
    return sectionId === "50_manual_review_required" || sectionId === "52_limitations"
      ? "MANUAL_REVIEW_ONLY"
      : null;
  }
  if (j.adminReviewStatus === "APPROVED_WITH_CAVEAT") return "CAVEATED_ANALYSIS";
  if (j.reviewDecision === "APPENDIX_ONLY" || j.adminReviewStatus === "APPENDIX_ONLY") {
    return sectionId === "54_evidence_appendix" ? "APPENDIX_ONLY" : null;
  }
  if (j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT" || j.adminReviewStatus === "APPROVED") {
    return "MAIN_ANALYSIS";
  }
  if (j.reviewDecision === "MANUAL_REVIEW_REQUIRED") return "CAVEATED_ANALYSIS";
  return j.reviewDecision === "APPENDIX_ONLY" ? null : "MAIN_ANALYSIS";
}

function matchesSection(sectionId: string, item: RawInventoryItem, j: EvidenceJudgment): boolean {
  const t = item.evidenceType.toLowerCase();
  const text = hay(item);
  const p = item.provider.toUpperCase();
  const ru = isRuRegion(item.region);
  const uae = isUaeRegion(item.region);
  const engine = providerHint(text, item.provider);

  switch (sectionId) {
    case "00_case_identity":
      return j.subjectBinding === "CONFIRMED" || j.subjectBinding === "LIKELY";
    case "03_digital_profile_overview":
      return t === "search_result" || t === "wikipedia" || t === "compliance_hit";
    case "10_ru_audit_summary":
      return ru && (t === "search_result" || t === "risk_finding" || t === "compliance_hit");
    case "11_ru_search_links":
      return ru && t === "search_result";
    case "12_ru_serp_position_table":
      return ru && (t.includes("serp") || t === "serp_screenshot" || t === "search_result");
    case "13_ru_undesirable_theme_clusters":
      return (
        ru &&
        (t === "search_result" || t === "risk_finding") &&
        /adverse|негativ|скандал|sanction|санкц|investigation|расслед|court|суд|compliance|pep/i.test(text)
      );
    case "14_ru_yandex_suggestions":
      return ru && t === "suggestion" && engine === "yandex";
    case "15_ru_google_suggestions":
      return ru && t === "suggestion" && engine !== "yandex";
    case "16_ru_wikipedia":
      return ru && t === "wikipedia";
    case "17_ru_yandex_images":
      return ru && (t.includes("image") || t === "search_surface_image") && engine === "yandex";
    case "18_ru_google_images":
      return ru && (t.includes("image") || t === "search_surface_image") && engine !== "yandex";
    case "19_ru_videos":
      return ru && (t.includes("video") || t === "search_surface_video");
    case "20_ru_yandex_knowledge_panel":
      return ru && (t.includes("knowledge") || t === "search_surface_knowledge") && engine === "yandex";
    case "21_ru_google_knowledge_panel":
      return ru && (t.includes("knowledge") || t === "search_surface_knowledge") && engine !== "yandex";
    case "22_ru_yandex_related_queries":
      return ru && (t === "suggestion" || t === "related_query") && engine === "yandex";
    case "23_ru_google_related_queries":
      return ru && (t === "suggestion" || t === "related_query") && engine !== "yandex";
    case "30_uae_audit_summary":
      return uae && (t === "search_result" || t === "risk_finding");
    case "31_uae_google_search_links":
      return uae && t === "search_result";
    case "32_uae_serp_position_table":
      return uae && (t.includes("serp") || t === "search_result");
    case "33_uae_undesirable_theme_clusters":
      return uae && (t === "search_result" || t === "risk_finding") && /adverse|sanction|compliance|pep/i.test(text);
    case "34_uae_google_suggestions":
      return uae && t === "suggestion";
    case "35_uae_wikipedia":
      return uae && t === "wikipedia";
    case "36_uae_google_images":
      return uae && t.includes("image");
    case "37_uae_google_videos":
      return uae && t.includes("video");
    case "38_uae_google_knowledge_panel":
      return uae && t.includes("knowledge");
    case "39_uae_google_related_queries":
      return uae && (t === "suggestion" || t === "related_query");
    case "40_compliance_database_summary":
      return t === "compliance_hit" || t === "database_profile" || t === "risk_finding";
    case "41_sanctions_watchlists":
      return (t === "compliance_hit" || t === "risk_finding") && /sanction|watchlist|санкц|pep|rca/i.test(text);
    case "42_dow_jones_profile":
      return p.includes("DOW") || /dow jones|dow_jones/i.test(text);
    case "43_world_check_profile":
      return p.includes("WORLD") || /world.?check|worldcheck/i.test(text);
    case "44_lexisnexis_profile":
      return p.includes("LEXIS") || /lexis/i.test(text);
    case "45_compliance_media_check":
      return (t === "compliance_hit" || t === "risk_finding" || t === "search_result") && /adverse|media|мedia|негativ/i.test(text);
    case "46_other_public_databases":
      return t === "database_profile" && !/lexis|dow|world/i.test(text);
    case "50_manual_review_required":
      return j.reviewDecision === "MANUAL_REVIEW_REQUIRED" || j.adminReviewStatus === "NEEDS_MORE_SOURCES";
    case "51_excluded_noise_summary":
      return j.reviewDecision === "EXCLUDE_NOISE";
    case "54_evidence_appendix":
      return j.reviewDecision === "APPENDIX_ONLY" || j.adminReviewStatus === "APPENDIX_ONLY";
    default:
      return false;
  }
}

function assessApplicability(
  entry: OrionSectionRegistryEntry,
  input: OrionSectionBundleBuilderInput,
  uaeEvidenceCount: number
): { applicable: boolean; reason: string } {
  if (entry.sectionId.startsWith("30_") || entry.sectionId.startsWith("31_") || entry.sectionId.startsWith("32_") || entry.sectionId.startsWith("33_") || entry.sectionId.startsWith("34_") || entry.sectionId.startsWith("35_") || entry.sectionId.startsWith("36_") || entry.sectionId.startsWith("37_") || entry.sectionId.startsWith("38_") || entry.sectionId.startsWith("39_")) {
    if (uaeEvidenceCount === 0 && input.regionSettings?.uaeEnabled !== true) {
      return { applicable: false, reason: "Нет материалов по ОАЭ — секция не применима." };
    }
  }
  if (entry.analysisMode === "EXECUTIVE_SYNTHESIS" || entry.analysisMode === "RISK_MATRIX_SYNTHESIS") {
    return { applicable: true, reason: "Синтезирующая секция — применима после секционных анализов." };
  }
  if (entry.sectionId === "00_case_identity") {
    return { applicable: true, reason: "Идентификация субъекта обязательна." };
  }
  return { applicable: true, reason: "Секция применима в режиме client_audit." };
}

function assessDataSufficiency(allowed: number, applicable: boolean, entry: OrionSectionRegistryEntry): OrionSectionDataSufficiency {
  if (!applicable) return "NOT_APPLICABLE";
  if (entry.analysisMode === "DETERMINISTIC_AGGREGATION" || entry.analysisMode === "APPENDIX_ONLY") {
    return allowed > 0 ? "SUFFICIENT" : "LIMITED";
  }
  if (allowed >= 3) return "SUFFICIENT";
  if (allowed >= 1) return "LIMITED";
  return "INSUFFICIENT";
}

export function buildOrionSectionBundles(input: OrionSectionBundleBuilderInput): OrionSectionBundle[] {
  const effectiveJudgments = applyAdminDecisionsToJudgments(input.judgments, input.adminDecisions).judgments;
  const itemById = new Map(input.inventory.items.map((i) => [i.inventoryId, i]));
  const judgmentById = new Map(effectiveJudgments.map((j) => [j.evidenceId, j]));

  const uaeEvidenceCount = input.inventory.items.filter((i) => isUaeRegion(i.region)).length;
  const registry = getClientAuditSections();

  return registry.map((entry) => {
    const { applicable, reason } = assessApplicability(entry, input, uaeEvidenceCount);
    const allowedEvidence: OrionSectionBundleEvidence[] = [];
    const excludedEvidenceSummary: Array<{ evidenceId: string; reason: string }> = [];
    let appendixOnly = 0;
    let manualReviewOnly = 0;

    const manualReviewSummary = {
      pendingCount: 0,
      approvedCount: 0,
      approvedWithCaveatCount: 0,
      appendixOnlyCount: 0,
      excludedCount: 0,
      wrongSubjectCount: 0,
    };

    for (const j of effectiveJudgments) {
      const item = itemById.get(j.evidenceId);
      if (!item) continue;

      if (j.reviewDecision === "EXCLUDE_WRONG_SUBJECT" || j.subjectBinding === "WRONG_SUBJECT") {
        manualReviewSummary.wrongSubjectCount += 1;
        excludedEvidenceSummary.push({ evidenceId: j.evidenceId, reason: "wrong_subject" });
        continue;
      }
      if (j.reviewDecision === "EXCLUDE_NOISE") {
        manualReviewSummary.excludedCount += 1;
        if (entry.sectionId === "51_excluded_noise_summary") {
          excludedEvidenceSummary.push({ evidenceId: j.evidenceId, reason: "excluded_noise" });
        }
        continue;
      }

      if (j.adminReviewStatus === "PENDING" && j.reviewDecision === "MANUAL_REVIEW_REQUIRED") {
        manualReviewSummary.pendingCount += 1;
      }
      if (j.adminReviewStatus === "APPROVED") manualReviewSummary.approvedCount += 1;
      if (j.adminReviewStatus === "APPROVED_WITH_CAVEAT") manualReviewSummary.approvedWithCaveatCount += 1;
      if (j.adminReviewStatus === "APPENDIX_ONLY" || j.reviewDecision === "APPENDIX_ONLY") {
        manualReviewSummary.appendixOnlyCount += 1;
      }

      if (!applicable) continue;
      if (!matchesSection(entry.sectionId, item, j)) continue;

      const clientUse = resolveClientUse(j, entry.sectionId);
      if (!clientUse) {
        excludedEvidenceSummary.push({
          evidenceId: j.evidenceId,
          reason: j.reviewDecision === "MANUAL_REVIEW_REQUIRED" ? "manual_review_pending" : "not_allowed_for_section",
        });
        continue;
      }

      if (clientUse === "APPENDIX_ONLY") appendixOnly += 1;
      if (clientUse === "MANUAL_REVIEW_ONLY") manualReviewOnly += 1;

      allowedEvidence.push({
        evidenceId: j.evidenceId,
        title: j.title,
        sourceType: item.evidenceType,
        sourceDomain: j.sourceDomain ?? domainOf(item.sourceUrl),
        url: j.url ?? item.sourceUrl,
        snippet: item.snippet?.slice(0, 300),
        subjectBinding: j.subjectBinding,
        subjectBindingScore: j.subjectBindingScore,
        subjectBindingExplanation: j.subjectBindingExplanation,
        relevance: j.relevance,
        sourceReliability: j.sourceReliability,
        contentNature: j.contentNature,
        riskSignal: j.riskSignal,
        reviewDecision: j.reviewDecision,
        adminReviewStatus: j.adminReviewStatus,
        clientUse,
        caveat:
          clientUse === "CAVEATED_ANALYSIS"
            ? j.clientSafeSummary.match(/\[Оговорка: ([^\]]+)\]/)?.[1] ?? "Требуется осторожная интерпретация."
            : undefined,
        whyIncluded: j.whyRelevant,
      });
    }

    if (entry.sectionId === "00_case_identity" && allowedEvidence.length === 0 && applicable) {
      allowedEvidence.push({
        evidenceId: `case-${input.caseInfo.caseId}`,
        title: input.caseInfo.subjectName,
        sourceType: "case_identity",
        subjectBinding: "CONFIRMED",
        relevance: "STRONG_RELEVANT",
        riskSignal: "NO_RISK_SIGNAL",
        reviewDecision: "AUTO_INCLUDE_CLIENT_REPORT",
        clientUse: "MAIN_ANALYSIS",
        whyIncluded: "Идентификация субъекта проверки из данных кейса.",
      });
    }

    if (entry.sectionId === "52_limitations") {
      allowedEvidence.length = 0;
    }

    const dataSufficiency = assessDataSufficiency(allowedEvidence.length, applicable, entry);
    const sectionWarnings: string[] = [];
    if (!applicable) sectionWarnings.push(reason);
    if (dataSufficiency === "INSUFFICIENT") sectionWarnings.push("Недостаточно материалов для полноценного анализа секции.");
    if (manualReviewOnly > 0 && entry.sectionId !== "50_manual_review_required") {
      sectionWarnings.push(`${manualReviewOnly} материал(ов) только для ручной проверки.`);
    }

    return {
      version: "r10-6-orion-section-bundle-v1",
      sectionId: entry.sectionId,
      order: entry.order,
      title: entry.titleRu,
      sectionPurpose: entry.sectionPurpose,
      analysisMode: entry.analysisMode,
      applicable,
      applicabilityReason: reason,
      allowedEvidence,
      excludedEvidenceSummary,
      manualReviewSummary,
      evidenceCounts: {
        totalCandidate: allowedEvidence.length + excludedEvidenceSummary.length,
        allowed: allowedEvidence.length,
        excluded: excludedEvidenceSummary.length,
        appendixOnly,
        manualReviewOnly,
      },
      dataSufficiency,
      sectionWarnings,
    };
  });
}

export function countInventoryRegions(inventory: FullEvidenceInventory): { ru: number; uae: number } {
  let ru = 0;
  let uae = 0;
  for (const item of inventory.items) {
    if (isUaeRegion(item.region)) uae += 1;
    else ru += 1;
  }
  return { ru, uae };
}
