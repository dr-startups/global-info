/**
 * Health-check primitives (Stage M2).
 *
 * PURE of Prisma so smoke:health can import these without the `@/` alias / DB.
 * The database check lives in `health-service.ts`. No secrets are ever exposed.
 */

import { randomBytes } from "node:crypto";
import { digitalProfileConfig } from "../config";
import { buildStorageKey } from "../storage/keys";
import { getStorageProvider } from "../storage/storage-provider";

export type ComponentStatus = "ok" | "error";
export type RendererStatus = "ok" | "unavailable";

/** Round-trips a tiny probe object through the active storage provider. */
export async function checkStorageHealth(): Promise<ComponentStatus> {
  let key: string | null = null;
  try {
    const provider = getStorageProvider();
    key = buildStorageKey.healthProbe(randomBytes(8).toString("hex"));
    const payload = Buffer.from("dp-health-probe");
    await provider.putObject(key, payload);
    const got = await provider.getObject(key);
    const ok = got.equals(payload);
    await provider.deleteObject(key);
    return ok ? "ok" : "error";
  } catch {
    if (key) {
      // Best-effort cleanup; ignore failures.
      try {
        await getStorageProvider().deleteObject(key);
      } catch {
        /* noop */
      }
    }
    return "error";
  }
}

/** Pings the renderer's /health endpoint; "unavailable" on any failure/timeout. */
export async function checkRendererHealth(
  timeoutMs = 2000
): Promise<RendererStatus> {
  try {
    const res = await fetch(`${digitalProfileConfig.rendererUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? "ok" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export interface HealthReport {
  ok: boolean;
  service: "digital-profile";
  database: ComponentStatus;
  storage: ComponentStatus;
  renderer: RendererStatus;
  authEnabled: boolean;
}

/** Overall ok requires database + storage healthy; renderer is non-fatal. */
export function composeHealth(parts: {
  database: ComponentStatus;
  storage: ComponentStatus;
  renderer: RendererStatus;
  authEnabled: boolean;
}): HealthReport {
  return {
    ok: parts.database === "ok" && parts.storage === "ok",
    service: "digital-profile",
    database: parts.database,
    storage: parts.storage,
    renderer: parts.renderer,
    authEnabled: parts.authEnabled,
  };
}
