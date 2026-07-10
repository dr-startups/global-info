/**
 * Build ReportAssetV1 entries from READY LIVE SerpCapture rows.
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
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
  const captures = await selectLiveSerpCaptures({
    reportRunId: input.reportRunId,
    slots: input.slots,
  });

  const out: ReportAssetV1[] = [];
  for (const capture of captures) {
    if (!capture.storageKey) continue;
    try {
      const buf = await loadFile(capture.storageKey);
      if (buf.length < 2000) continue;
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
      } as ReportAssetV1 & {
        geoStatus?: string;
        connectionMode?: string;
        captureId?: string;
      });
    } catch {
      // unreadable storage — skip
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
  for (const query of input.ruQueries) {
    slots.push({ query, engine: "YANDEX", region: "RU" });
    slots.push({ query, engine: "GOOGLE", region: "RU" });
  }
  for (const query of input.uaeQueries) {
    slots.push({ query, engine: "GOOGLE", region: "UAE" });
  }
  return slots;
}

export function isClientProductionFinalize(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORION_CLASSIC_CLIENT_FINALIZE === "1";
}

/** Pure policy helper for QA/tests — client production must not use synthetic or unverified LIVE. */
export function evaluateClientSerpPolicy(
  assets: ReportAssetV1[],
  clientProductionFinalize: boolean
): { passed: boolean; blockers: string[] } {
  if (!clientProductionFinalize) return { passed: true, blockers: [] };
  const blockers: string[] = [];
  const live = assets.filter((a) => a.kind === "live_serp" && a.status === "ready");
  const synthetic = assets.filter((a) => a.kind === "synthetic_serp" && a.status === "ready");
  const unverified = live.filter((a) => a.geoStatus === "UNVERIFIED");
  if (synthetic.length > 0) blockers.push("live-serp-no-synthetic-substitute");
  if (unverified.length > 0) blockers.push("live-serp-geo-unverified");
  if (live.length === 0) blockers.push("live-serp-missing");
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
