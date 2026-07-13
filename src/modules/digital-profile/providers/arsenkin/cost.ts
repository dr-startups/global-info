/**
 * Honest Arsenkin cost accounting: never treat missing limits as zero spend.
 */

export type ArsenkinCostStatus = "KNOWN" | "UNKNOWN";

export function computeLimitsSpent(
  limitsBefore: number | null | undefined,
  limitsAfter: number | null | undefined
): number | null {
  if (limitsBefore == null || limitsAfter == null) return null;
  if (!Number.isFinite(limitsBefore) || !Number.isFinite(limitsAfter)) return null;
  return Math.max(0, Math.trunc(limitsBefore) - Math.trunc(limitsAfter));
}

export function costStatusFromSpent(limitsSpent: number | null | undefined): ArsenkinCostStatus {
  return limitsSpent == null ? "UNKNOWN" : "KNOWN";
}
