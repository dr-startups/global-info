import { renderSerpSnapshotPng } from "../serp-snapshot/renderer";
import type { ResultView, SerpSnapshotViewModel } from "../serp-snapshot/types";
import { saveFile, sha256 } from "../storage/private-store";
import { buildStorageKey } from "../storage/keys";
import { prisma } from "@/server/prisma/client";
import {
  SYNTHETIC_API_SERP_CAPTION,
  type PersistedSerpObservation,
} from "./types";

function toResultView(obs: PersistedSerpObservation): ResultView {
  return {
    rank: obs.rank,
    title: obs.title ?? obs.domain ?? "Результат поиска",
    url: obs.url,
    domain: obs.domain ?? "",
    snippet: obs.snippet ?? "",
    classification: "",
    isHighlighted: false,
  };
}

export function buildSyntheticSerpViewModelFromObservations(input: {
  observations: PersistedSerpObservation[];
  subjectName: string;
  queryText: string;
}): SerpSnapshotViewModel {
  const resultViews = [...input.observations]
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 8)
    .map(toResultView);
  const query = input.queryText;
  const dateLabel = new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());

  return {
    title: "Поисковая выдача",
    dateLabel,
    subjectName: input.subjectName,
    query,
    language: "ru",
    themes: [],
    noNegatives: true,
    engines: {
      yandex: { engine: "YANDEX", query, results: [], empty: true },
      google: {
        engine: "GOOGLE",
        query,
        results: resultViews,
        empty: resultViews.length === 0,
      },
    },
    width: 1400,
    height: 900,
    footerNote: SYNTHETIC_API_SERP_CAPTION,
    sourceLabel: "Google · Serper API",
  };
}

/**
 * Render synthetic SERP PNG from persisted observations, store file + DB row,
 * and link each observation for audit traceability.
 */
export async function createSyntheticSerpAssetFromObservations(input: {
  caseId: string;
  auditRunId: string;
  queryId: string;
  queryText: string;
  subjectName: string;
  region: string;
  language: string;
  observations: PersistedSerpObservation[];
}): Promise<{
  assetId: string;
  storageKey: string;
  sha256: string;
  caption: string;
  observationIds: string[];
  png: Buffer;
}> {
  if (input.observations.length === 0) {
    throw new Error("createSyntheticSerpAssetFromObservations: no observations");
  }
  const auditRunIds = new Set(input.observations.map((o) => o.auditRunId));
  if (auditRunIds.size !== 1 || !auditRunIds.has(input.auditRunId)) {
    throw new Error("createSyntheticSerpAssetFromObservations: auditRunId mismatch");
  }

  const vm = buildSyntheticSerpViewModelFromObservations({
    observations: input.observations,
    subjectName: input.subjectName,
    queryText: input.queryText,
  });
  const png = await renderSerpSnapshotPng(vm);
  const digest = sha256(png);

  const assetId = `synserp_${Date.now().toString(36)}_${digest.slice(0, 10)}`;
  const storageKey = buildStorageKey.serpSyntheticAsset(input.caseId, assetId, "png");
  await saveFile(storageKey, png);

  const row = await prisma.serpSyntheticAsset.create({
    data: {
      id: assetId,
      caseId: input.caseId,
      auditRunId: input.auditRunId,
      queryId: input.queryId,
      provider: "serper",
      engine: "GOOGLE",
      surface: "organic",
      region: input.region,
      language: input.language,
      storageKey,
      sha256: digest,
      mimeType: "image/png",
      width: vm.width,
      height: vm.height,
      caption: SYNTHETIC_API_SERP_CAPTION,
      status: "READY",
      observations: {
        create: input.observations.map((o) => ({
          observationId: o.id,
          rank: o.rank,
        })),
      },
    },
  });

  return {
    assetId: row.id,
    storageKey,
    sha256: digest,
    caption: SYNTHETIC_API_SERP_CAPTION,
    observationIds: input.observations.map((o) => o.id),
    png,
  };
}
