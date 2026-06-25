/**
 * Private file storage facade (kept for back-compat).
 *
 * Delegates to the configured storage provider (local by default). Files are
 * NEVER served from a public path — access is only via signed-URL download
 * routes. Storage keys are validated to prevent path traversal (see `keys.ts`).
 */

import { createHash } from "node:crypto";
import { getStorageProvider } from "./storage-provider";

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function saveFile(
  storageKey: string,
  buffer: Buffer
): Promise<{ storageKey: string; sizeBytes: number; sha256: string }> {
  return getStorageProvider().putObject(storageKey, buffer);
}

export async function loadFile(storageKey: string): Promise<Buffer> {
  return getStorageProvider().getObject(storageKey);
}

export async function fileExists(storageKey: string): Promise<boolean> {
  return getStorageProvider().exists(storageKey);
}
