/**
 * Screenshot evidence service (Stage C).
 *
 * Stores uploaded screenshots in PRIVATE storage (never a public path), records
 * a SHA-256 for tamper-evidence, and serves them only through signed-URL
 * download. Deletion is a soft delete and is admin-guarded at the route level —
 * evidence files are never removed from disk here.
 */

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../http/errors";
import { recordAudit } from "./audit-log-service";
import { loadFile, saveFile } from "../storage/private-store";
import { buildScreenshotDownloadUrl, verifySignedToken } from "../storage/signed-url";
import type { ActorContext } from "./case-service";

const EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export interface AddScreenshotInput {
  buffer: Buffer;
  mimeType: string;
  sourceUrl?: string;
  resultId?: string;
}

export interface ScreenshotResultDTO {
  id: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number | null;
  sourceUrl: string | null;
  resultId: string | null;
  capturedAt: Date;
  downloadUrl: string;
}

async function ensureActiveCase(caseId: string): Promise<void> {
  const found = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Case not found");
}

export async function addScreenshot(
  caseId: string,
  input: AddScreenshotInput,
  ctx: ActorContext = {}
): Promise<ScreenshotResultDTO> {
  await ensureActiveCase(caseId);

  const ext = EXT_BY_MIME[input.mimeType] ?? "bin";
  const fileId = randomUUID();
  const storageKey = `${caseId}/screenshots/${fileId}.${ext}`;
  const saved = await saveFile(storageKey, input.buffer);

  const row = await prisma.screenshot.create({
    data: {
      caseId,
      resultId: input.resultId ?? null,
      storageKey: saved.storageKey,
      mimeType: input.mimeType,
      sha256: saved.sha256,
      sizeBytes: saved.sizeBytes,
      sourceUrl: input.sourceUrl ?? null,
      capturedBy: ctx.actorId ?? null,
    },
    select: {
      id: true,
      mimeType: true,
      sha256: true,
      sizeBytes: true,
      sourceUrl: true,
      resultId: true,
      capturedAt: true,
      storageKey: true,
    },
  });

  await recordAudit({
    caseId,
    action: "SCREENSHOT_ADDED",
    actorId: ctx.actorId,
    metadata: { screenshotId: row.id, sha256: row.sha256 },
  });

  return {
    id: row.id,
    mimeType: row.mimeType,
    sha256: row.sha256,
    sizeBytes: row.sizeBytes,
    sourceUrl: row.sourceUrl,
    resultId: row.resultId,
    capturedAt: row.capturedAt,
    downloadUrl: buildScreenshotDownloadUrl(row.id, row.storageKey),
  };
}

export interface ScreenshotFile {
  buffer: Buffer;
  mimeType: string;
  storageKey: string;
}

/**
 * Validates a signed token and returns the file bytes for download.
 * Throws NotFound if the screenshot is missing/deleted or the token is invalid.
 */
export async function getScreenshotForDownload(
  screenshotId: string,
  token: string,
  ctx: ActorContext = {}
): Promise<ScreenshotFile> {
  const row = await prisma.screenshot.findFirst({
    where: { id: screenshotId, deletedAt: null },
    select: { id: true, caseId: true, storageKey: true, mimeType: true },
  });
  if (!row) throw new NotFoundError("Screenshot not found");

  if (!verifySignedToken(row.storageKey, token)) {
    // Do not distinguish invalid vs missing to avoid leaking storage keys.
    throw new NotFoundError("Screenshot not found");
  }

  const buffer = await loadFile(row.storageKey);
  await recordAudit({
    caseId: row.caseId,
    action: "SCREENSHOT_DOWNLOADED",
    actorId: ctx.actorId,
    metadata: { screenshotId },
  });

  return { buffer, mimeType: row.mimeType, storageKey: row.storageKey };
}

/**
 * Soft-deletes a screenshot (admin action). The file stays on disk; only the
 * DB record is flagged so evidence is never silently destroyed.
 */
export async function softDeleteScreenshot(
  screenshotId: string,
  ctx: ActorContext = {}
): Promise<{ id: string; deletedAt: Date | null }> {
  try {
    const row = await prisma.screenshot.update({
      where: { id: screenshotId },
      data: { deletedAt: new Date(), deletedBy: ctx.actorId ?? "admin" },
      select: { id: true, deletedAt: true, caseId: true },
    });
    await recordAudit({
      caseId: row.caseId,
      action: "SCREENSHOT_SOFT_DELETED",
      actorId: ctx.actorId,
      metadata: { screenshotId },
    });
    return { id: row.id, deletedAt: row.deletedAt };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2025"
    ) {
      throw new NotFoundError("Screenshot not found");
    }
    throw err;
  }
}
