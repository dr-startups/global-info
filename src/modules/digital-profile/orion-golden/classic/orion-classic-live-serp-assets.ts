/**
 * Build ReportAssetV1 entries from READY LIVE SerpCapture rows.
 */

import type { ReportAssetV1 } from "../assets/asset-builder";
import { loadFile } from "../../storage/private-store";
import {
  selectLiveSerpCaptures,
  type SerpCaptureEngine,
  type SerpCaptureRecord,
  type SerpCaptureRegion,
} from "../../serp-capture";

export type ClassicSerpAudience = "client" | "internal_preview";

export interface LiveSerpSlot {
  query: string;
  engine: SerpCaptureEngine;
  region: SerpCaptureRegion;
}

function providerLabel(engine: SerpCaptureEngine): "yandex" | "google" {
  return engine === "YANDEX" ? "yandex" : "google";
}

function buildCaption(capture: SerpCaptureRecord): string {
  const base = `Запрос: ${capture.query} · LIVE browser capture`;
  if (capture.geoStatus === "UNVERIFIED") {
    return `${base} · GEO не подтверждено`;
  }
  if (capture.geoStatus === "VERIFIED") {
    return `${base} · GEO подтверждено`;
  }
  return base;
}

function titleForCapture(capture: SerpCaptureRecord): string {
  const provider = providerLabel(capture.engine);
  if (provider === "yandex") return `Яндекс — ${capture.query}`;
  return `Google — ${capture.query}`;
}

export async function buildLiveSerpAssets(input: {
  reportRunId: string;
  slots: LiveSerpSlot[];
  audience?: ClassicSerpAudience;
}): Promise<ReportAssetV1[]> {
  console.info("[serp-capture] select for report", {
    reportRunId: input.reportRunId,
    audience: input.audience ?? "client",
    slotCount: input.slots.length,
    slots: input.slots.map((s) => `${s.region}/${s.engine}:${s.query}`),
  });

  const captures = await selectLiveSerpCaptures({
    reportRunId: input.reportRunId,
    slots: input.slots,
  });

  console.info("[serp-capture] select result", {
    reportRunId: input.reportRunId,
    matched: captures.length,
    ids: captures.map((c) => c.id),
    statuses: captures.map((c) => `${c.engine}/${c.region}:${c.captureStatus}/${c.geoStatus}`),
  });

  const out: ReportAssetV1[] = [];
  for (const capture of captures) {
    if (!capture.storageKey) {
      console.warn("[serp-capture] READY row missing storageKey", { captureId: capture.id });
      continue;
    }
    try {
      const buf = await loadFile(capture.storageKey);
      if (buf.length < 2000) {
        console.warn("[serp-capture] PNG too small, skip", {
          captureId: capture.id,
          bytes: buf.length,
        });
        continue;
      }
      const provider = providerLabel(capture.engine);
      const prefix = capture.region === "UAE" ? "uae_live_serp" : "ru_live_serp";
      out.push({
        assetRef: `${prefix}_${provider}_${capture.id}`,
        kind: "live_serp",
        title: titleForCapture(capture),
        caption: buildCaption(capture),
        imageData: buf.toString("base64"),
        evidenceRefs: [`serp_capture:${capture.id}`],
        status: "ready",
        geoStatus: capture.geoStatus,
        connectionMode: capture.connectionMode,
        captureId: capture.id,
      });
    } catch (err) {
      console.warn("[serp-capture] loadFile failed", {
        captureId: capture.id,
        storageKey: capture.storageKey,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export function buildDefaultLiveSerpSlots(input: {
  subjectName: string;
  ruQueries: string[];
  uaeQueries: string[];
}): LiveSerpSlot[] {
  const slots: LiveSerpSlot[] = [];
  const seen = new Set<string>();
  const push = (query: string, engine: SerpCaptureEngine, region: SerpCaptureRegion) => {
    const q = query.trim();
    if (!q) return;
    const key = `${region}|${engine}|${q.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    slots.push({ query: q, engine, region });
  };

  // UI captures the subject FIO — always include it so READY rows match the report.
  const subject = input.subjectName.trim();
  if (subject) {
    push(subject, "YANDEX", "RU");
    push(subject, "GOOGLE", "RU");
    push(subject, "GOOGLE", "UAE");
  }
  for (const query of input.ruQueries) {
    push(query, "YANDEX", "RU");
    push(query, "GOOGLE", "RU");
  }
  for (const query of input.uaeQueries) {
    push(query, "GOOGLE", "UAE");
  }
  return slots;
}

export function isClientProductionFinalize(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORION_CLASSIC_CLIENT_FINALIZE === "1";
}

/** CEO First36 MVP: audit-only deck (no commercial trailer), exact-36 target. */
export function isFirst36CeoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORION_FIRST36_CEO_MODE === "1";
}

/** Pure policy helper for QA/tests — client production uses provider API SERP (or READY LIVE/captured). */
export function evaluateClientSerpPolicy(
  assets: ReportAssetV1[],
  clientProductionFinalize: boolean
): { passed: boolean; blockers: string[] } {
  if (!clientProductionFinalize) return { passed: true, blockers: [] };
  const blockers: string[] = [];
  const readyVisual = assets.filter(
    (a) =>
      a.status === "ready" &&
      Boolean(a.imageData || a.imageUrl) &&
      (a.kind === "live_serp" || a.kind === "captured_serp" || a.kind === "synthetic_serp")
  );
  const providerApi = readyVisual.filter(
    (a) =>
      a.evidenceRefs.some((r) => r.startsWith("serp_observation:")) ||
      /provider_serp|serper_organic|yandex_organic/i.test(a.assetRef)
  );
  const live = readyVisual.filter((a) => a.kind === "live_serp");
  const captured = readyVisual.filter((a) => a.kind === "captured_serp");
  const legacySynthetic = readyVisual.filter(
    (a) =>
      a.kind === "synthetic_serp" &&
      !a.evidenceRefs.some((r) => r.startsWith("serp_observation:")) &&
      !/provider_serp|serper_organic|yandex_organic/i.test(a.assetRef)
  );
  const unverified = live.filter((a) => a.geoStatus === "UNVERIFIED");

  // Legacy evidence-derived synthetic must not substitute required visuals in client finalize.
  if (legacySynthetic.length > 0 && providerApi.length === 0 && live.length === 0 && captured.length === 0) {
    blockers.push("legacy-synthetic-serp-not-allowed-for-client");
  }
  if (unverified.length > 0 && providerApi.length === 0 && captured.length === 0) {
    blockers.push("live-serp-geo-unverified");
  }

  const ru = [...providerApi, ...live, ...captured].filter((a) => !/uae|intl|ae_/i.test(a.assetRef));
  const uae = [...providerApi, ...live, ...captured].filter((a) => /uae|intl|ae_/i.test(a.assetRef));
  if (ru.length === 0) blockers.push("ru-serp-visual-missing");
  if (uae.length === 0) blockers.push("uae-serp-visual-missing");

  return { passed: blockers.length === 0, blockers };
}

/** Map terminal capture statuses for tests. */
export function resolveLiveCaptureOutcome(input: {
  captchaDetected: boolean;
  proxyUsed: boolean;
  pngOk: boolean;
}): {
  captureStatus: "READY" | "BLOCKED_CAPTCHA" | "FAILED";
  geoStatus: "VERIFIED" | "UNVERIFIED" | "UNKNOWN";
  connectionMode: "PROXY" | "DIRECT";
} {
  const connectionMode = input.proxyUsed ? "PROXY" : "DIRECT";
  if (input.captchaDetected) {
    return { captureStatus: "BLOCKED_CAPTCHA", geoStatus: "UNKNOWN", connectionMode };
  }
  if (!input.pngOk) {
    return { captureStatus: "FAILED", geoStatus: "UNKNOWN", connectionMode };
  }
  return {
    captureStatus: "READY",
    geoStatus: input.proxyUsed ? "VERIFIED" : "UNVERIFIED",
    connectionMode,
  };
}
