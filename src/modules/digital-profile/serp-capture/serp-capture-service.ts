import { prisma } from "@/server/prisma/client";
import type { Prisma } from "@prisma/client";
import { saveFile, sha256 } from "../storage/private-store";
import { buildStorageKey } from "../storage/keys";
import { captureSerpWithPlaywright, type PlaywrightCaptureFn } from "./playwright-capture";
import { resolveSerpCaptureProxy } from "./proxy";
import {
  buildAllowlistedSerpUrl,
  hashSerpQuery,
  normalizeSerpQuery,
  SerpUrlBuilderError,
} from "./url-builder";
import type {
  LiveSerpCaptureRequest,
  SerpCaptureRecord,
  SerpCaptureStatus,
  SerpConnectionMode,
  SerpGeoStatus,
} from "./types";
import { DEFAULT_SERP_CAPTURE_DEVICE } from "./types";

function mapRow(row: {
  id: string;
  caseId: string;
  reportRunId: string;
  query: string;
  queryHash: string;
  engine: string;
  region: string;
  locale: string;
  device: string;
  captureStatus: string;
  geoStatus: string;
  connectionMode: string;
  storageKey: string | null;
  sha256: string | null;
  sourceUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  capturedAt: Date | null;
  capturedBy: string | null;
  metadataJson: unknown;
  errorJson: unknown;
  createdAt: Date;
  updatedAt: Date;
}): SerpCaptureRecord {
  return {
    id: row.id,
    caseId: row.caseId,
    reportRunId: row.reportRunId,
    query: row.query,
    queryHash: row.queryHash,
    engine: row.engine as SerpCaptureRecord["engine"],
    region: row.region as SerpCaptureRecord["region"],
    locale: row.locale,
    device: row.device as SerpCaptureRecord["device"],
    captureStatus: row.captureStatus as SerpCaptureStatus,
    geoStatus: row.geoStatus as SerpGeoStatus,
    connectionMode: row.connectionMode as SerpConnectionMode,
    storageKey: row.storageKey,
    sha256: row.sha256,
    sourceUrl: row.sourceUrl,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    capturedAt: row.capturedAt,
    capturedBy: row.capturedBy,
    metadataJson:
      row.metadataJson && typeof row.metadataJson === "object" && !Array.isArray(row.metadataJson)
        ? (row.metadataJson as Record<string, unknown>)
        : null,
    errorJson:
      row.errorJson && typeof row.errorJson === "object" && !Array.isArray(row.errorJson)
        ? (row.errorJson as Record<string, unknown>)
        : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function assertReportRunBelongsToCase(
  caseId: string,
  reportRunId: string
): Promise<void> {
  const run = await prisma.orionReportRun.findFirst({
    where: { id: reportRunId, caseId },
    select: { id: true },
  });
  if (!run) throw new SerpUrlBuilderError("report-run-not-found");
}

export interface CaptureLiveSerpOptions {
  captureFn?: PlaywrightCaptureFn;
}

/**
 * Reusable LIVE SERP capture entrypoint.
 * Manual API today; orchestrator can call the same function later.
 */
export async function captureLiveSerp(
  request: LiveSerpCaptureRequest,
  options: CaptureLiveSerpOptions = {}
): Promise<SerpCaptureRecord> {
  await assertReportRunBelongsToCase(request.caseId, request.reportRunId);

  const query = normalizeSerpQuery(request.query);
  const queryHash = hashSerpQuery(query);
  const device = request.device ?? DEFAULT_SERP_CAPTURE_DEVICE;
  const { url, locale } = buildAllowlistedSerpUrl({
    query,
    engine: request.engine,
    region: request.region,
    locale: request.locale,
  });

  const proxyServer = resolveSerpCaptureProxy(request.region);
  const connectionMode: SerpConnectionMode = proxyServer ? "PROXY" : "DIRECT";

  const row = await prisma.serpCapture.create({
    data: {
      caseId: request.caseId,
      reportRunId: request.reportRunId,
      query,
      queryHash,
      engine: request.engine,
      region: request.region,
      locale,
      device,
      captureStatus: "PENDING",
      geoStatus: "UNKNOWN",
      connectionMode,
      capturedBy: request.capturedBy ?? null,
      metadataJson: { mode: "LIVE", requestedAt: new Date().toISOString() },
    },
  });

  await prisma.serpCapture.update({
    where: { id: row.id },
    data: { captureStatus: "RUNNING" },
  });

  const captureFn = options.captureFn ?? captureSerpWithPlaywright;

  try {
    const result = await captureFn({ url, proxyServer });

    if (result.captchaDetected) {
      const updated = await prisma.serpCapture.update({
        where: { id: row.id },
        data: {
          captureStatus: "BLOCKED_CAPTCHA",
          sourceUrl: result.finalUrl,
          metadataJson: toInputJson({
            mode: "LIVE",
            pageTitle: result.pageTitle,
            diagnostics: result.diagnostics,
          }),
          errorJson: {
            code: "BLOCKED_CAPTCHA",
            message: "CAPTCHA detected — capture not stored as READY evidence",
          },
        },
      });
      return mapRow(updated);
    }

    const digest = sha256(result.png);
    const storageKey = buildStorageKey.serpCapture(request.caseId, row.id, "png");
    await saveFile(storageKey, result.png);

    const geoStatus: SerpGeoStatus = proxyServer ? "VERIFIED" : "UNVERIFIED";

    const updated = await prisma.serpCapture.update({
      where: { id: row.id },
      data: {
        captureStatus: "READY",
        geoStatus,
        connectionMode,
        storageKey,
        sha256: digest,
        sourceUrl: url,
        mimeType: "image/png",
        sizeBytes: result.png.byteLength,
        capturedAt: new Date(),
        metadataJson: toInputJson({
          mode: "LIVE",
          pageTitle: result.pageTitle,
          finalUrl: result.finalUrl,
          geoStatus,
          connectionMode,
          diagnostics: result.diagnostics,
        }),
        errorJson: undefined,
      },
    });
    return mapRow(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const updated = await prisma.serpCapture.update({
      where: { id: row.id },
      data: {
        captureStatus: "FAILED",
        errorJson: { code: "CAPTURE_FAILED", message },
        metadataJson: {
          mode: "LIVE",
          failedAt: new Date().toISOString(),
        },
      },
    });
    return mapRow(updated);
  }
}

export async function listSerpCapturesForRun(reportRunId: string): Promise<SerpCaptureRecord[]> {
  const rows = await prisma.serpCapture.findMany({
    where: { reportRunId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(mapRow);
}

export { SerpUrlBuilderError };

function toInputJson(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
