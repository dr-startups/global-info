/**
 * Configuration for the ORION-style synthetic SERP snapshot generator (Stage S1).
 *
 * All values come from `DIGITAL_PROFILE_SERP_SNAPSHOT_*` env vars and have safe
 * defaults so the feature works in dev/demo without any setup. The module is
 * synthetic and key-free: no provider credentials or external calls are ever
 * required (enforced by the smoke test).
 */

import type { SerpEngine } from "./types";

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const raw = (value ?? "").trim();
  // Number("") === 0, so an unset/empty var must fall back, not clamp to min.
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function envList(value: string | undefined, fallback: string[]): string[] {
  const raw = (value ?? "").trim();
  if (raw === "") return fallback;
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

export interface SerpSnapshotConfig {
  enabled: boolean;
  format: "png" | "jpg";
  width: number;
  height: number;
  maxResultsPerEngine: number;
  maxThemes: number;
  /** Classifications (and risk themes) that mark a result as highlighted. */
  highlightClassifications: string[];
}

export const serpSnapshotConfig: SerpSnapshotConfig = {
  enabled: envBool(process.env.DIGITAL_PROFILE_SERP_SNAPSHOT_ENABLED, true),
  format:
    (process.env.DIGITAL_PROFILE_SERP_SNAPSHOT_FORMAT ?? "png").trim().toLowerCase() === "jpg"
      ? "jpg"
      : "png",
  width: envInt(process.env.DIGITAL_PROFILE_SERP_SNAPSHOT_WIDTH, 1600, 800, 4000),
  height: envInt(process.env.DIGITAL_PROFILE_SERP_SNAPSHOT_HEIGHT, 950, 600, 4000),
  maxResultsPerEngine: envInt(
    process.env.DIGITAL_PROFILE_SERP_SNAPSHOT_MAX_RESULTS_PER_ENGINE,
    7,
    1,
    20
  ),
  maxThemes: envInt(process.env.DIGITAL_PROFILE_SERP_SNAPSHOT_MAX_THEMES, 5, 1, 10),
  highlightClassifications: envList(
    process.env.DIGITAL_PROFILE_SERP_SNAPSHOT_HIGHLIGHT_CLASSIFICATIONS,
    [
      "ADVERSE_MEDIA",
      "SANCTIONS",
      "PEP",
      "NEGATIVE",
      "HIGH_RISK",
      // Present in the current ResultClassification enum and treated as risky.
      "CRIMINAL",
      "LEGAL",
    ]
  ),
};

export const DEFAULT_ENGINES: SerpEngine[] = ["YANDEX", "GOOGLE"];

/** MIME type for the configured output format. */
export function snapshotMimeType(): string {
  return serpSnapshotConfig.format === "jpg" ? "image/jpeg" : "image/png";
}

/** File extension for the configured output format. */
export function snapshotExtension(): "png" | "jpg" {
  return serpSnapshotConfig.format;
}
