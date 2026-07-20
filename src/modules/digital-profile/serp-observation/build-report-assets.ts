/**
 * In-memory vertical slice: Serper organic drafts → synthetic PNG → ReportAssetV1.
 * Persistence (Prisma) is optional and used by production ingest paths.
 * Does not modify prompts or the Python renderer.
 */

import { renderSerpSnapshotPng } from "../serp-snapshot/renderer";
import type { ReportAssetV1 } from "../orion-golden/assets/asset-builder";
import {
  buildSyntheticSerpViewModelFromObservations,
} from "./synthetic-asset";
import { serpSyntheticAssetToReportAsset } from "./to-report-asset";
import type { PersistedSerpObservation, SerpObservationDraft } from "./types";
import { createHash } from "node:crypto";

function asPersisted(drafts: SerpObservationDraft[]): PersistedSerpObservation[] {
  return drafts.map((d, i) => ({
    ...d,
    id: d.queryId.slice(0, 8) + `_obs_${i + 1}`,
    searchDocumentId: null,
  }));
}

export async function buildSerperOrganicReportAssetsFromDrafts(input: {
  drafts: SerpObservationDraft[];
  subjectName: string;
  assetIdPrefix?: string;
}): Promise<{
  assets: ReportAssetV1[];
  auditRunIds: string[];
  observationIds: string[];
}> {
  const byQuery = new Map<string, SerpObservationDraft[]>();
  for (const d of input.drafts) {
    const list = byQuery.get(d.queryId) ?? [];
    list.push(d);
    byQuery.set(d.queryId, list);
  }

  const assets: ReportAssetV1[] = [];
  const observationIds: string[] = [];
  const auditRunIds = [...new Set(input.drafts.map((d) => d.auditRunId))];

  for (const [queryId, group] of byQuery) {
    const persisted = asPersisted(group);
    observationIds.push(...persisted.map((p) => p.id));
    const vm = buildSyntheticSerpViewModelFromObservations({
      observations: persisted,
      subjectName: input.subjectName,
      queryText: group[0]?.queryText ?? "",
    });
    const png = await renderSerpSnapshotPng(vm);
    const digest = createHash("sha256").update(png).digest("hex").slice(0, 12);
    const assetId = `${input.assetIdPrefix ?? "serper"}_${queryId.slice(0, 10)}_${digest}`;
    assets.push(
      serpSyntheticAssetToReportAsset({
        assetId,
        queryText: group[0]?.queryText ?? "",
        pngBase64: png.toString("base64"),
        observationIds: persisted.map((p) => p.id),
        status: "ready",
      })
    );
  }

  return { assets, auditRunIds, observationIds };
}
