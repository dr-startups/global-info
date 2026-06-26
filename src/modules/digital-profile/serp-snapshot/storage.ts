/**
 * Storage for SERP snapshots (Stage S1).
 *
 * Reuses the existing private storage provider + `Screenshot` table (no new
 * migration). A snapshot is one Screenshot row plus two storage objects:
 *   cases/{caseId}/serp-snapshots/{snapshotId}/orion-serp-snapshot.png
 *   cases/{caseId}/serp-snapshots/{snapshotId}/metadata.json
 * The row is discriminated from raw evidence by the storage-key marker so it is
 * filtered out of the evidence screenshot listing.
 */

import { randomUUID } from "node:crypto";
import { prisma } from "@/server/prisma/client";
import { saveFile, loadFile, sha256 } from "../storage/private-store";
import { buildStorageKey } from "../storage/keys";
import { buildScreenshotDownloadUrl } from "../storage/signed-url";
import { snapshotExtension, snapshotMimeType } from "./config";
import type { SerpSnapshotMetadata } from "./types";

export interface PersistedSnapshot {
  id: string;
  storageKey: string;
  metadataKey: string;
  signedUrl: string;
  sha256: string;
  sizeBytes: number;
  capturedAt: Date;
}

/**
 * Writes the PNG + metadata to private storage and records a Screenshot row.
 * Returns identifiers and a fresh signed download URL.
 */
export async function persistSnapshot(
  caseId: string,
  image: Buffer,
  metadata: SerpSnapshotMetadata,
  actorId?: string | null
): Promise<PersistedSnapshot> {
  const snapshotId = randomUUID();
  const ext = snapshotExtension();
  const storageKey = buildStorageKey.serpSnapshot(caseId, snapshotId, ext);
  const metadataKey = buildStorageKey.serpSnapshotMetadata(caseId, snapshotId);

  const digest = sha256(image);
  await saveFile(storageKey, image);
  await saveFile(metadataKey, Buffer.from(JSON.stringify(metadata, null, 2), "utf8"));

  const row = await prisma.screenshot.create({
    data: {
      id: snapshotId,
      caseId,
      storageKey,
      mimeType: snapshotMimeType(),
      sha256: digest,
      sizeBytes: image.byteLength,
      sourceUrl: null,
      capturedBy: actorId ?? null,
    },
    select: { id: true, storageKey: true, capturedAt: true },
  });

  return {
    id: row.id,
    storageKey: row.storageKey,
    metadataKey,
    signedUrl: buildScreenshotDownloadUrl(row.id, row.storageKey),
    sha256: digest,
    sizeBytes: image.byteLength,
    capturedAt: row.capturedAt,
  };
}

export interface LatestSnapshot {
  id: string;
  storageKey: string;
  signedUrl: string;
  metadata: SerpSnapshotMetadata | null;
  capturedAt: Date;
  sha256: string;
  sizeBytes: number | null;
}

/** Returns the most recent SERP snapshot for a case, or null if none exist. */
export async function getLatestSnapshot(caseId: string): Promise<LatestSnapshot | null> {
  const row = await prisma.screenshot.findFirst({
    where: {
      caseId,
      deletedAt: null,
      storageKey: { contains: "/serp-snapshots/" },
    },
    orderBy: { capturedAt: "desc" },
    select: { id: true, storageKey: true, capturedAt: true, sha256: true, sizeBytes: true },
  });
  if (!row) return null;

  const metadataKey = buildStorageKey.serpSnapshotMetadata(caseId, row.id);
  let metadata: SerpSnapshotMetadata | null = null;
  try {
    const buf = await loadFile(metadataKey);
    metadata = JSON.parse(buf.toString("utf8")) as SerpSnapshotMetadata;
  } catch {
    metadata = null;
  }

  return {
    id: row.id,
    storageKey: row.storageKey,
    signedUrl: buildScreenshotDownloadUrl(row.id, row.storageKey),
    metadata,
    capturedAt: row.capturedAt,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
  };
}
