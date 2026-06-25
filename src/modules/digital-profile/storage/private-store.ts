/**
 * Private file storage for evidence (screenshots, imported files) and reports.
 *
 * Files live under `digitalProfileConfig.storageDir` and are NEVER served from a
 * public path. Access is only via signed-URL download routes. Storage keys are
 * validated to prevent path traversal.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { digitalProfileConfig } from "../config";

const ROOT = path.resolve(digitalProfileConfig.storageDir);

/** Rejects keys that try to escape the storage root. */
function resolveKey(storageKey: string): string {
  const normalized = path
    .normalize(storageKey)
    .replace(/^([/\\])+/, "");
  const full = path.resolve(ROOT, normalized);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return full;
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function saveFile(
  storageKey: string,
  buffer: Buffer
): Promise<{ storageKey: string; sizeBytes: number; sha256: string }> {
  const full = resolveKey(storageKey);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buffer);
  return { storageKey, sizeBytes: buffer.byteLength, sha256: sha256(buffer) };
}

export async function loadFile(storageKey: string): Promise<Buffer> {
  return readFile(resolveKey(storageKey));
}

export async function fileExists(storageKey: string): Promise<boolean> {
  try {
    await access(resolveKey(storageKey));
    return true;
  } catch {
    return false;
  }
}
