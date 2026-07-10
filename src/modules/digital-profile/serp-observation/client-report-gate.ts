import type { ReportAssetV1 } from "../orion-report-spec/asset-builder";

export type RequiredVisualSection = {
  sectionKey: string;
  /** Asset refs that must include at least one READY asset. */
  requiredAssetRefs: string[];
};

/**
 * Client report must block when a required visual section has no READY asset.
 * Do not substitute a text-only page.
 */
export function evaluateClientVisualAssetGate(input: {
  requiredSections: RequiredVisualSection[];
  assets: ReportAssetV1[];
}): {
  allowed: boolean;
  blockedSections: Array<{ sectionKey: string; reason: string; missingRefs: string[] }>;
} {
  const readyByRef = new Map<string, ReportAssetV1>();
  for (const a of input.assets) {
    if (a.status === "ready" && (a.imageData || a.imageUrl)) {
      readyByRef.set(a.assetRef, a);
    }
  }

  const blockedSections: Array<{ sectionKey: string; reason: string; missingRefs: string[] }> = [];
  for (const section of input.requiredSections) {
    const missing = section.requiredAssetRefs.filter((ref) => !readyByRef.has(ref));
    const anyReady = section.requiredAssetRefs.some((ref) => readyByRef.has(ref));
    if (!anyReady) {
      blockedSections.push({
        sectionKey: section.sectionKey,
        reason: "REQUIRED_VISUAL_ASSET_MISSING",
        missingRefs: missing,
      });
    }
  }

  return {
    allowed: blockedSections.length === 0,
    blockedSections,
  };
}
