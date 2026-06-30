/**
 * Stage O5 — report selection policy.
 */

import type {
  EvidenceItemInput,
  EvidenceQualityAssessment,
  GatedEvidenceItem,
  ReportAudience,
  ReportEligibility,
} from "./types";
import { evaluateEvidenceItem } from "./gate";

type SelectableItem = EvidenceItemInput & { quality?: EvidenceQualityAssessment };

export interface SelectionResult<T extends EvidenceItemInput = EvidenceItemInput> {
  selected: Array<T & { quality: EvidenceQualityAssessment }>;
  excluded: Array<T & { quality: EvidenceQualityAssessment }>;
  reviewRequired: Array<T & { quality: EvidenceQualityAssessment }>;
}

const CLIENT_ALLOWED: ReadonlySet<ReportEligibility> = new Set(["CLIENT_INCLUDE"]);

const INTERNAL_ALLOWED: ReadonlySet<ReportEligibility> = new Set([
  "CLIENT_INCLUDE",
  "INTERNAL_ONLY",
  "REVIEW_REQUIRED",
]);

function isAllowedForAudience(eligibility: ReportEligibility, audience: ReportAudience): boolean {
  if (audience === "CLIENT") return CLIENT_ALLOWED.has(eligibility);
  return INTERNAL_ALLOWED.has(eligibility);
}

/** Central selection function — filters gated items by audience. */
export function selectEvidenceForReport<T extends SelectableItem>(
  items: T[],
  audience: ReportAudience,
  _reportLanguage: "ru" | "en" = "ru"
): SelectionResult<T> {
  const selected: SelectionResult<T>["selected"] = [];
  const excluded: SelectionResult<T>["excluded"] = [];
  const reviewRequired: SelectionResult<T>["reviewRequired"] = [];

  for (const item of items) {
    const quality = item.quality ?? evaluateEvidenceItem(item);
    const gated = { ...item, quality };
    if (quality.reportEligibility === "REVIEW_REQUIRED") {
      reviewRequired.push(gated);
      if (audience === "INTERNAL") selected.push(gated);
      continue;
    }
    if (quality.reportEligibility === "EXCLUDE") {
      excluded.push(gated);
      continue;
    }
    if (isAllowedForAudience(quality.reportEligibility, audience)) {
      selected.push(gated);
    } else {
      excluded.push(gated);
    }
  }

  return { selected, excluded, reviewRequired };
}

export function filterGatedItemsForAudience(
  items: GatedEvidenceItem[],
  audience: ReportAudience
): GatedEvidenceItem[] {
  return selectEvidenceForReport(items, audience).selected;
}

export { isClientSafeReportJson } from "../report/report-data-policy";
