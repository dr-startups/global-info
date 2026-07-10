import { prisma } from "@/server/prisma/client";
import { hashSerpQuery } from "./url-builder";
import type { SelectLiveSerpCapturesInput, SerpCaptureRecord } from "./types";
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
    captureStatus: row.captureStatus as SerpCaptureRecord["captureStatus"],
    geoStatus: row.geoStatus as SerpCaptureRecord["geoStatus"],
    connectionMode: row.connectionMode as SerpCaptureRecord["connectionMode"],
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

/**
 * Select READY LIVE captures with exact match on reportRunId + query + engine + region + device.
 * Never returns "latest case screenshot" — only bound captures for the current run.
 */
export async function selectLiveSerpCaptures(
  input: SelectLiveSerpCapturesInput
): Promise<SerpCaptureRecord[]> {
  const device = input.device ?? DEFAULT_SERP_CAPTURE_DEVICE;
  const out: SerpCaptureRecord[] = [];

  for (const slot of input.slots) {
    const queryHash = hashSerpQuery(slot.query);
    const row = await prisma.serpCapture.findFirst({
      where: {
        reportRunId: input.reportRunId,
        queryHash,
        engine: slot.engine,
        region: slot.region,
        device,
        captureStatus: "READY",
      },
      orderBy: { capturedAt: "desc" },
    });
    if (row) out.push(mapRow(row));
  }

  return out;
}

export async function listReadyLiveCapturesForRun(
  reportRunId: string
): Promise<SerpCaptureRecord[]> {
  const rows = await prisma.serpCapture.findMany({
    where: { reportRunId, captureStatus: "READY" },
    orderBy: { capturedAt: "desc" },
  });
  return rows.map(mapRow);
}
