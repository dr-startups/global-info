import { renderSerpSnapshotPng } from "../serp-snapshot/renderer";
import type { SerpLanguage, SerpSnapshotViewModel } from "../serp-snapshot/types";
import { saveFile, sha256 } from "../storage/private-store";
import { buildStorageKey } from "../storage/keys";
import { prisma } from "@/server/prisma/client";
import { filterObservationsForSyntheticSerp } from "./filter-synthetic-serp-noise";
import {
  buildObservationThemeGrouping,
  classifyObservationHighlight,
  observationToResultView,
} from "./resolve-observation-highlights";
import {
  SYNTHETIC_API_SERP_CAPTION,
  type PersistedSerpObservation,
} from "./types";

/** Max organic rows drawn per engine column in the synthetic PNG. */
const VISIBLE_PER_ENGINE = 8;

/**
 * Pick rows that will actually appear in a column.
 * Prefer adverse-highlighted hits so left-column themes match red frames,
 * then fill remaining slots by original rank order.
 */
export function selectVisibleObservationsForEngine(
  observations: PersistedSerpObservation[],
  engine: "YANDEX" | "GOOGLE",
  limit = VISIBLE_PER_ENGINE
): PersistedSerpObservation[] {
  const sorted = observations
    .filter((o) => o.engine === engine)
    .sort((a, b) => a.rank - b.rank);
  if (sorted.length <= limit) return sorted;

  const highlighted: PersistedSerpObservation[] = [];
  const neutral: PersistedSerpObservation[] = [];
  for (const o of sorted) {
    if (classifyObservationHighlight(o).isHighlighted) highlighted.push(o);
    else neutral.push(o);
  }

  const picked: PersistedSerpObservation[] = [];
  const seen = new Set<string>();
  const push = (o: PersistedSerpObservation) => {
    if (picked.length >= limit || seen.has(o.id)) return;
    seen.add(o.id);
    picked.push(o);
  };
  for (const o of highlighted) push(o);
  for (const o of neutral) push(o);
  return picked.sort((a, b) => a.rank - b.rank);
}

export function buildSyntheticSerpViewModelFromObservations(input: {
  observations: PersistedSerpObservation[];
  subjectName: string;
  queryText: string;
  language?: SerpLanguage;
}): SerpSnapshotViewModel {
  const language: SerpLanguage = input.language === "en" ? "en" : "ru";
  const query = input.queryText;
  const observations = filterObservationsForSyntheticSerp(
    input.observations,
    input.subjectName
  );

  const yandexObs = selectVisibleObservationsForEngine(observations, "YANDEX");
  const googleObs = selectVisibleObservationsForEngine(observations, "GOOGLE");
  const visible = [...yandexObs, ...googleObs];

  // Themes/legend only from rows that appear in the PNG columns.
  const { grouping } = buildObservationThemeGrouping(visible, language);

  const yandexResults = yandexObs.map((o) => observationToResultView(o, grouping));
  const googleResults = googleObs.map((o) => observationToResultView(o, grouping));

  const dateLabel = new Intl.DateTimeFormat(language === "en" ? "en-GB" : "ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());

  const hasYandex = yandexResults.length > 0;
  const hasGoogle = googleResults.length > 0;
  const sourceLabel =
    hasYandex && hasGoogle
      ? "Yandex Search API / Google · Serper API"
      : hasYandex
        ? "Yandex Search API"
        : "Google · Serper API";

  return {
    title: "Поисковая выдача",
    dateLabel,
    subjectName: input.subjectName,
    query,
    language,
    themes: grouping.themes,
    noNegatives: grouping.themes.length === 0,
    engines: {
      yandex: {
        engine: "YANDEX",
        query,
        results: yandexResults,
        empty: !hasYandex,
      },
      google: {
        engine: "GOOGLE",
        query,
        results: googleResults,
        empty: !hasGoogle,
      },
    },
    width: 1400,
    height: 900,
    footerNote: SYNTHETIC_API_SERP_CAPTION,
    sourceLabel,
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

  const hasYandex = input.observations.some((o) => o.engine === "YANDEX");
  const hasGoogle = input.observations.some((o) => o.engine === "GOOGLE");
  const provider =
    hasYandex && hasGoogle ? "provider_serp" : hasYandex ? "yandex" : "serper";
  const engine = hasYandex && hasGoogle ? "DUAL" : hasYandex ? "YANDEX" : "GOOGLE";

  const vm = buildSyntheticSerpViewModelFromObservations({
    observations: input.observations,
    subjectName: input.subjectName,
    queryText: input.queryText,
    language: input.language.startsWith("en") ? "en" : "ru",
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
      provider,
      engine,
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
