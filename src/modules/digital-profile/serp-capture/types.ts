/**
 * Stage S2 — LIVE browser SERP capture types.
 */

export type SerpCaptureEngine = "GOOGLE" | "YANDEX";
export type SerpCaptureRegion = "RU" | "UAE";
export type SerpCaptureDevice = "DESKTOP";

export type SerpCaptureStatus =
  | "PENDING"
  | "RUNNING"
  | "READY"
  | "BLOCKED_CAPTCHA"
  | "FAILED";

export type SerpGeoStatus = "VERIFIED" | "UNVERIFIED" | "UNKNOWN";
export type SerpConnectionMode = "PROXY" | "DIRECT";

export interface LiveSerpCaptureRequest {
  caseId: string;
  reportRunId: string;
  query: string;
  engine: SerpCaptureEngine;
  region: SerpCaptureRegion;
  locale?: string;
  device?: SerpCaptureDevice;
  capturedBy?: string | null;
}

export interface PlaywrightCaptureInput {
  url: string;
  proxyServer?: string;
  viewport?: { width: number; height: number };
}

export interface PlaywrightCaptureResult {
  png: Buffer;
  finalUrl: string;
  pageTitle: string;
  captchaDetected: boolean;
  diagnostics: Record<string, unknown>;
}

export interface SerpCaptureRecord {
  id: string;
  caseId: string;
  reportRunId: string;
  query: string;
  queryHash: string;
  engine: SerpCaptureEngine;
  region: SerpCaptureRegion;
  locale: string;
  device: SerpCaptureDevice;
  captureStatus: SerpCaptureStatus;
  geoStatus: SerpGeoStatus;
  connectionMode: SerpConnectionMode;
  storageKey: string | null;
  sha256: string | null;
  sourceUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  capturedAt: Date | null;
  capturedBy: string | null;
  metadataJson: Record<string, unknown> | null;
  errorJson: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SelectLiveSerpCapturesInput {
  reportRunId: string;
  device?: SerpCaptureDevice;
  slots: Array<{
    query: string;
    engine: SerpCaptureEngine;
    region: SerpCaptureRegion;
  }>;
}

export const DEFAULT_SERP_CAPTURE_DEVICE: SerpCaptureDevice = "DESKTOP";
export const DEFAULT_SERP_CAPTURE_VIEWPORT = { width: 1400, height: 900 } as const;
