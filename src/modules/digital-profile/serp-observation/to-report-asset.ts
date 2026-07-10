import type { ReportAssetV1 } from "../orion-report-spec/asset-builder";
import { SYNTHETIC_API_SERP_CAPTION } from "./types";

/**
 * Map a persisted synthetic SERP asset (+ observation ids) into ReportSpec asset.
 * evidenceRefs trace to SerpObservation rows.
 */
export function serpSyntheticAssetToReportAsset(input: {
  assetId: string;
  queryText: string;
  pngBase64: string;
  observationIds: string[];
  status?: "ready" | "missing";
}): ReportAssetV1 {
  const ready = input.status !== "missing" && Boolean(input.pngBase64);
  return {
    assetRef: `serper_organic_serp_${input.assetId}`,
    kind: "synthetic_serp",
    title: `Google — ${input.queryText}`,
    caption: SYNTHETIC_API_SERP_CAPTION,
    imageData: ready ? input.pngBase64 : undefined,
    evidenceRefs: input.observationIds.map((id) => `serp_observation:${id}`),
    status: ready ? "ready" : "missing",
  };
}
