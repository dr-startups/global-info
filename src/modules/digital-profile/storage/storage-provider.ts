/**
 * Storage provider factory (Stage M2).
 *
 * Selects the active provider from `digitalProfileConfig.storage.driver`.
 * Only the `local` driver is implemented today; `s3`/`r2`/`supabase` are
 * recognized values reserved for future drivers and fail fast with a clear
 * message so a misconfigured deploy never silently falls back.
 */

import { digitalProfileConfig } from "../config";
import { LocalStorageProvider } from "./local-storage-provider";
import type { StorageProvider } from "./types";

let cached: StorageProvider | null = null;

export function getStorageProvider(): StorageProvider {
  if (cached) return cached;

  const driver = digitalProfileConfig.storage.driver;
  switch (driver) {
    case "local":
      cached = new LocalStorageProvider();
      return cached;
    case "s3":
    case "r2":
    case "supabase":
      throw new Error(
        `Storage driver "${driver}" is not implemented yet. ` +
          `Set DIGITAL_PROFILE_STORAGE_DRIVER=local or add the driver behind StorageProvider.`
      );
    default:
      throw new Error(`Unknown storage driver "${driver}".`);
  }
}

/** Test-only: reset the cached provider (used by smoke tests). */
export function __resetStorageProvider(): void {
  cached = null;
}
