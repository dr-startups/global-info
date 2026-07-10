/**
 * Classic ORION audit — provider-first Google/Serper + Yandex SERP assets.
 * Persists SerpObservation rows under one auditRunId and builds synthetic PNGs.
 * No browser scraping, no residential proxy, no CAPTCHA bypass.
 */

import { ensureOrionReportRunForCapture } from "../../serp-capture";
import { loadFile } from "../../storage/private-store";
import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import {
  transliterateRuToEn,
  type OrionRegionCode,
} from "../../search-surfaces/orion-query-plan";
import {
  SYNTHETIC_API_SERP_CAPTION,
  ingestSerperOrganicObservations,
  ingestYandexOrganicObservations,
  persistSerpObservations,
  createSyntheticSerpAssetFromObservations,
  serpSyntheticAssetToReportAsset,
  buildSerpQueryId,
  type SerpProviderStatus,
  type PersistedSerpObservation,
  type SerpObservationDraft,
} from "../../serp-observation";
import { prisma } from "@/server/prisma/client";

const CYRILLIC_RE = /[А-Яа-яЁё]/;

export type ProviderSerpSlot = {
  query: string;
  region: "RU" | "UAE";
  language: string;
};

export type ProviderSerpSlotStatus = {
  query: string;
  region: "RU" | "UAE";
  status: SerpProviderStatus | "READY_CACHED" | "READY_NEW";
  message?: string;
  assetRef?: string;
  googleStatus?: SerpProviderStatus | "SKIPPED";
  yandexStatus?: SerpProviderStatus | "SKIPPED";
};

function isProviderApiSerpAsset(asset: ReportAssetV1): boolean {
  return (
    asset.kind === "synthetic_serp" &&
    asset.status === "ready" &&
    (asset.evidenceRefs.some((r) => r.startsWith("serp_observation:")) ||
      asset.caption === SYNTHETIC_API_SERP_CAPTION ||
      /provider_serp|serper_organic|yandex_organic/i.test(asset.assetRef))
  );
}

export { isProviderApiSerpAsset };

export function buildDefaultProviderSerpSlots(input: {
  subjectName: string;
  ruQueries: string[];
  uaeQueries: string[];
}): ProviderSerpSlot[] {
  const slots: ProviderSerpSlot[] = [];
  const seen = new Set<string>();
  const push = (query: string, region: "RU" | "UAE", language: string) => {
    const q = query.trim();
    if (!q) return;
    const key = `${region}|${q.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    slots.push({ query: q, region, language });
  };

  const subject = input.subjectName.trim();
  if (subject) {
    push(subject, "RU", "ru");
    // Serper UAE/EN returns poorly on Cyrillic FIO — prefer Latin transliteration.
    const uaeSubject = CYRILLIC_RE.test(subject) ? transliterateRuToEn(subject) : subject;
    push(uaeSubject, "UAE", "en");
  }
  for (const q of input.ruQueries.slice(0, 1)) push(q, "RU", "ru");
  for (const q of input.uaeQueries.slice(0, 1)) push(q, "UAE", "en");
  return slots;
}

function slotQueryId(input: {
  auditRunId: string;
  region: string;
  language: string;
  queryText: string;
}): string {
  return buildSerpQueryId({
    auditRunId: input.auditRunId,
    provider: "provider_serp",
    engine: "DUAL",
    region: input.region,
    language: input.language,
    queryText: input.queryText,
    surface: "organic",
  });
}

async function loadCachedSyntheticAsset(input: {
  auditRunId: string;
  queryId: string;
  queryText: string;
  region: "RU" | "UAE";
}): Promise<ReportAssetV1 | null> {
  const row = await prisma.serpSyntheticAsset.findFirst({
    where: { auditRunId: input.auditRunId, queryId: input.queryId, status: "READY" },
    include: { observations: { orderBy: { rank: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  if (!row?.storageKey) return null;
  try {
    const buf = await loadFile(row.storageKey);
    if (buf.length < 2000) return null;
    const prefix = input.region === "UAE" ? "uae_provider_serp" : "ru_provider_serp";
    const asset = serpSyntheticAssetToReportAsset({
      assetId: row.id,
      queryText: input.queryText,
      pngBase64: buf.toString("base64"),
      observationIds: row.observations.map((o) => o.observationId),
      status: "ready",
      storageKey: row.storageKey,
      engines: row.engine,
    });
    return {
      ...asset,
      assetRef: `${prefix}_${row.id}`,
    };
  } catch {
    return null;
  }
}

async function buildOneProviderSlot(input: {
  caseId: string;
  auditRunId: string;
  subjectName: string;
  slot: ProviderSerpSlot;
}): Promise<{ asset: ReportAssetV1 | null; status: ProviderSerpSlotStatus }> {
  const regionCode = input.slot.region as OrionRegionCode;
  const queryId = slotQueryId({
    auditRunId: input.auditRunId,
    region: input.slot.region,
    language: input.slot.language,
    queryText: input.slot.query,
  });

  const cached = await loadCachedSyntheticAsset({
    auditRunId: input.auditRunId,
    queryId,
    queryText: input.slot.query,
    region: input.slot.region,
  });
  if (cached) {
    return {
      asset: cached,
      status: {
        query: input.slot.query,
        region: input.slot.region,
        status: "READY_CACHED",
        assetRef: cached.assetRef,
        googleStatus: "SKIPPED",
        yandexStatus: "SKIPPED",
      },
    };
  }

  const [googleIngest, yandexIngest] = await Promise.all([
    ingestSerperOrganicObservations({
      caseId: input.caseId,
      auditRunId: input.auditRunId,
      queryText: input.slot.query,
      region: regionCode,
      language: input.slot.language,
      subjectFullName: input.subjectName,
      limit: 10,
    }),
    ingestYandexOrganicObservations({
      caseId: input.caseId,
      auditRunId: input.auditRunId,
      queryText: input.slot.query,
      region: regionCode,
      language: input.slot.language,
      subjectFullName: input.subjectName,
      limit: 10,
    }),
  ]);

  const drafts: SerpObservationDraft[] = [
    ...(googleIngest.status === "OK" ? googleIngest.observations : []),
    ...(yandexIngest.status === "OK" ? yandexIngest.observations : []),
  ];

  if (drafts.length === 0) {
    const status: SerpProviderStatus =
      googleIngest.status === "PROVIDER_BLOCKED_CAPTCHA" ||
      yandexIngest.status === "PROVIDER_BLOCKED_CAPTCHA"
        ? "PROVIDER_BLOCKED_CAPTCHA"
        : googleIngest.status === "PROVIDER_NOT_CONFIGURED" &&
            yandexIngest.status === "PROVIDER_NOT_CONFIGURED"
          ? "PROVIDER_NOT_CONFIGURED"
          : googleIngest.status === "NO_RESULTS" && yandexIngest.status === "NO_RESULTS"
            ? "NO_RESULTS"
            : "PROVIDER_FAILED";
    console.warn("[provider-serp] slot not OK", {
      auditRunId: input.auditRunId,
      query: input.slot.query,
      region: input.slot.region,
      google: googleIngest.status,
      yandex: yandexIngest.status,
    });
    return {
      asset: null,
      status: {
        query: input.slot.query,
        region: input.slot.region,
        status,
        message: `google=${googleIngest.status}; yandex=${yandexIngest.status}`,
        googleStatus: googleIngest.status,
        yandexStatus: yandexIngest.status,
      },
    };
  }

  const persisted = await persistSerpObservations(drafts);
  const synthetic = await createSyntheticSerpAssetFromObservations({
    caseId: input.caseId,
    auditRunId: input.auditRunId,
    queryId,
    queryText: input.slot.query,
    subjectName: input.subjectName,
    region: input.slot.region,
    language: input.slot.language,
    observations: persisted as PersistedSerpObservation[],
  });

  const prefix = input.slot.region === "UAE" ? "uae_provider_serp" : "ru_provider_serp";
  const engines =
    googleIngest.status === "OK" && yandexIngest.status === "OK"
      ? "DUAL"
      : yandexIngest.status === "OK"
        ? "YANDEX"
        : "GOOGLE";
  const asset = {
    ...serpSyntheticAssetToReportAsset({
      assetId: synthetic.assetId,
      queryText: input.slot.query,
      pngBase64: synthetic.png.toString("base64"),
      observationIds: synthetic.observationIds,
      status: "ready",
      storageKey: synthetic.storageKey,
      engines,
    }),
    assetRef: `${prefix}_${synthetic.assetId}`,
  };

  return {
    asset,
    status: {
      query: input.slot.query,
      region: input.slot.region,
      status: "READY_NEW",
      assetRef: asset.assetRef,
      googleStatus: googleIngest.status,
      yandexStatus: yandexIngest.status,
    },
  };
}

/**
 * Build Google/Serper + Yandex organic synthetic SERP assets for classic audit.
 * All observations share the same auditRunId (= reportRunId).
 */
export async function buildProviderSerpAssets(input: {
  caseId: string;
  auditRunId: string;
  subjectName: string;
  ruQueries: string[];
  uaeQueries: string[];
}): Promise<{ assets: ReportAssetV1[]; slotStatuses: ProviderSerpSlotStatus[] }> {
  await ensureOrionReportRunForCapture(input.caseId, input.auditRunId);

  const slots = buildDefaultProviderSerpSlots({
    subjectName: input.subjectName,
    ruQueries: input.ruQueries,
    uaeQueries: input.uaeQueries,
  });

  console.info("[provider-serp] build start", {
    caseId: input.caseId,
    auditRunId: input.auditRunId,
    slots: slots.map((s) => `${s.region}:${s.query}`),
  });

  const assets: ReportAssetV1[] = [];
  const slotStatuses: ProviderSerpSlotStatus[] = [];

  for (const slot of slots) {
    try {
      const { asset, status } = await buildOneProviderSlot({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        subjectName: input.subjectName,
        slot,
      });
      slotStatuses.push(status);
      if (asset) assets.push(asset);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[provider-serp] slot failed", {
        query: slot.query,
        region: slot.region,
        message,
      });
      slotStatuses.push({
        query: slot.query,
        region: slot.region,
        status: "PROVIDER_FAILED",
        message,
      });
    }
  }

  console.info("[provider-serp] build done", {
    auditRunId: input.auditRunId,
    ready: assets.length,
    statuses: slotStatuses.map(
      (s) => `${s.region}:${s.status}(g=${s.googleStatus ?? "-"},y=${s.yandexStatus ?? "-"})`
    ),
  });

  return { assets, slotStatuses };
}

/** Client visual gate: required SERP screenshot sections need READY provider/manual assets. */
export function evaluateClassicProviderSerpGate(input: {
  assets: ReportAssetV1[];
  requireRu: boolean;
  requireUae: boolean;
}): {
  allowed: boolean;
  blockedSections: Array<{ sectionKey: string; reason: string }>;
} {
  const ready = input.assets.filter(
    (a) =>
      a.status === "ready" &&
      Boolean(a.imageData || a.imageUrl) &&
      (a.kind === "synthetic_serp" || a.kind === "captured_serp" || a.kind === "live_serp")
  );
  const providerOrManual = ready.filter(
    (a) => isProviderApiSerpAsset(a) || a.kind === "captured_serp" || a.kind === "live_serp"
  );

  const blockedSections: Array<{ sectionKey: string; reason: string }> = [];
  if (input.requireRu) {
    const ru = providerOrManual.filter((a) => !/uae|intl|ae_/i.test(a.assetRef));
    if (ru.length === 0) {
      blockedSections.push({
        sectionKey: "ru_serp_screenshots",
        reason: "REQUIRED_VISUAL_ASSET_MISSING",
      });
    }
  }
  if (input.requireUae) {
    const uae = providerOrManual.filter((a) => /uae|intl|ae_/i.test(a.assetRef));
    if (uae.length === 0) {
      blockedSections.push({
        sectionKey: "uae_serp_screenshots",
        reason: "REQUIRED_VISUAL_ASSET_MISSING",
      });
    }
  }

  return { allowed: blockedSections.length === 0, blockedSections };
}
