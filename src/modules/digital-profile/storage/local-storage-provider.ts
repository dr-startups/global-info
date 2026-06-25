/**
 * Local (private filesystem) storage provider (Stage M2).
 *
 * Default driver. Files live under `digitalProfileConfig.storage.root` and are
 * NEVER exposed on a public path — reads go through signed download routes only.
 * Every key is validated (no traversal, no absolute paths) before any I/O, and
 * the resolved absolute path is re-checked to stay inside the root.
 */

import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { digitalProfileConfig } from "../config";
import { createSignedToken } from "./signed-url";
import { preventPathTraversal } from "./keys";
import type {
  PutObjectOptions,
  PutObjectResult,
  SignedReadUrl,
  SignedReadUrlOptions,
  StorageObjectInfo,
  StorageProvider,
} from "./types";

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export class LocalStorageProvider implements StorageProvider {
  readonly driver = "local" as const;
  private readonly root: string;

  constructor(root = digitalProfileConfig.storage.root) {
    this.root = path.resolve(root);
  }

  /** Validates the key and resolves to an absolute path inside the root. */
  private resolve(key: string): string {
    const safe = preventPathTraversal(key);
    const full = path.resolve(this.root, safe);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error("Invalid storage key");
    }
    return full;
  }

  getPrivatePath(key: string): string {
    return this.resolve(key);
  }

  async putObject(
    key: string,
    buffer: Buffer,
    _options?: PutObjectOptions
  ): Promise<PutObjectResult> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, buffer);
    return {
      storageKey: preventPathTraversal(key),
      sizeBytes: buffer.byteLength,
      sha256: sha256(buffer),
    };
  }

  async getObject(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
      throw err;
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  createSignedReadUrl(key: string, options: SignedReadUrlOptions): SignedReadUrl {
    const safeKey = preventPathTraversal(key);
    const ttl =
      options.ttlSeconds ?? digitalProfileConfig.storage.signedUrlTtlSeconds;
    const { token, expiresAt } = createSignedToken(safeKey, ttl);
    const enc = encodeURIComponent(token);
    const r = options.resource;
    const url =
      r.kind === "report"
        ? `/api/digital-profile/reports/${r.reportVersionId}/download?type=${r.type}&token=${enc}`
        : `/api/digital-profile/screenshots/${r.screenshotId}/download?token=${enc}`;
    return { url, token, expiresAt };
  }

  async listObjects(prefix: string): Promise<StorageObjectInfo[]> {
    // Validate the prefix as a key path (allow it to be a directory prefix).
    const safePrefix = preventPathTraversal(prefix);
    const base = this.resolve(safePrefix);
    const out: StorageObjectInfo[] = [];

    async function walk(dir: string, rel: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // missing prefix -> empty list
      }
      for (const entry of entries) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        const childAbs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(childAbs, childRel);
        } else if (entry.isFile()) {
          const s = await stat(childAbs);
          out.push({
            storageKey: childRel,
            sizeBytes: s.size,
            updatedAt: s.mtimeMs,
          });
        }
      }
    }

    await walk(base, safePrefix);
    return out;
  }
}
