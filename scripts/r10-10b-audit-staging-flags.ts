/**
 * R10.10b — Audit staging flags without printing secret values.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function envBool(v: string | undefined): boolean | null {
  if (v == null || v === "") return null;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function loadEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    // strip accidental nested quotes like ""local""
    while (v.startsWith('"') || v.startsWith("'")) v = v.slice(1);
    while (v.endsWith('"') || v.endsWith("'")) v = v.slice(0, -1);
    out[k] = v;
  }
  return out;
}

const root = process.cwd();
const merged: Record<string, string> = {
  ...loadEnvFile(join(root, ".env")),
  ...loadEnvFile(join(root, ".env.production")),
  ...loadEnvFile(join(root, ".env.local")),
};

const DEFAULT_SECRET = "change-me-in-production";
const secret = merged.DIGITAL_PROFILE_SESSION_SECRET ?? "";
const secretPresent = secret.length > 0;
const secretStrong = secretPresent && secret !== DEFAULT_SECRET && secret.length >= 16;

const storageRaw = merged.DIGITAL_PROFILE_STORAGE_DRIVER ?? "";
const storageOk = ["local", "s3", "r2", "supabase"].includes(storageRaw);

const report = {
  DIGITAL_PROFILE_ENABLED: {
    present: "DIGITAL_PROFILE_ENABLED" in merged,
    truthy: envBool(merged.DIGITAL_PROFILE_ENABLED),
    ready: envBool(merged.DIGITAL_PROFILE_ENABLED) === true,
  },
  DIGITAL_PROFILE_ORION_GOLDEN_ENABLED: {
    present: "DIGITAL_PROFILE_ORION_GOLDEN_ENABLED" in merged,
    truthy: envBool(merged.DIGITAL_PROFILE_ORION_GOLDEN_ENABLED),
    // may be unset in file; staging should set true explicitly
    ready:
      envBool(merged.DIGITAL_PROFILE_ORION_GOLDEN_ENABLED) === true ||
      !("DIGITAL_PROFILE_ORION_GOLDEN_ENABLED" in merged),
  },
  ORION_CLIENT_AUDIT_MODE: {
    present: "ORION_CLIENT_AUDIT_MODE" in merged,
    truthy: envBool(merged.ORION_CLIENT_AUDIT_MODE),
    note: "set at runtime for client-audit smoke",
  },
  R10_RENDER_FROM_CLIENT_CONTENT: {
    present: "R10_RENDER_FROM_CLIENT_CONTENT" in merged,
    truthy: envBool(merged.R10_RENDER_FROM_CLIENT_CONTENT),
    note: "set at runtime for client-audit smoke",
  },
  ORION_ADMIN_REVIEW_DECISION_STORE: {
    present: "ORION_ADMIN_REVIEW_DECISION_STORE" in merged,
    value: merged.ORION_ADMIN_REVIEW_DECISION_STORE ?? "artifact(default)",
    ready:
      !merged.ORION_ADMIN_REVIEW_DECISION_STORE ||
      merged.ORION_ADMIN_REVIEW_DECISION_STORE === "artifact",
  },
  DIGITAL_PROFILE_AI_ANALYST_ENABLED: {
    present: "DIGITAL_PROFILE_AI_ANALYST_ENABLED" in merged,
    truthy: envBool(merged.DIGITAL_PROFILE_AI_ANALYST_ENABLED),
  },
  DIGITAL_PROFILE_AI_ANALYST_MODEL: {
    present: "DIGITAL_PROFILE_AI_ANALYST_MODEL" in merged,
    value: merged.DIGITAL_PROFILE_AI_ANALYST_MODEL ?? "gpt-5.5(default)",
  },
  DIGITAL_PROFILE_AUTH_ENABLED: {
    present: "DIGITAL_PROFILE_AUTH_ENABLED" in merged,
    truthy: envBool(merged.DIGITAL_PROFILE_AUTH_ENABLED),
    ready: envBool(merged.DIGITAL_PROFILE_AUTH_ENABLED) === true,
  },
  DIGITAL_PROFILE_SESSION_SECRET: {
    present: secretPresent,
    strong: secretStrong,
    weak: secretPresent && !secretStrong,
    lengthBucket: !secretPresent ? "missing" : secret.length < 16 ? "lt16" : "ge16",
  },
  DIGITAL_PROFILE_STORAGE_DRIVER: {
    present: "DIGITAL_PROFILE_STORAGE_DRIVER" in merged,
    value: storageRaw || "(unset)",
    valid: storageOk || !storageRaw,
    ready: storageOk || !storageRaw,
  },
  RENDERER_URL: {
    present: "RENDERER_URL" in merged || "DIGITAL_PROFILE_RENDERER_URL" in merged,
    value:
      merged.RENDERER_URL ??
      merged.DIGITAL_PROFILE_RENDERER_URL ??
      "(unset — docker default http://renderer:8080)",
  },
  DIGITAL_PROFILE_AUTH_ALLOW_SYNTHETIC: {
    present: "DIGITAL_PROFILE_AUTH_ALLOW_SYNTHETIC" in merged,
    truthy: envBool(merged.DIGITAL_PROFILE_AUTH_ALLOW_SYNTHETIC),
  },
};

const blockers: string[] = [];
if (!report.DIGITAL_PROFILE_AUTH_ENABLED.ready) blockers.push("AUTH_NOT_ENABLED_IN_ENV_FILE");
if (!secretStrong) blockers.push(secretPresent ? "SESSION_SECRET_WEAK" : "SESSION_SECRET_MISSING");
if (!report.ORION_ADMIN_REVIEW_DECISION_STORE.ready) blockers.push("DECISION_STORE_NOT_ARTIFACT");
if (storageRaw && !storageOk) blockers.push("STORAGE_DRIVER_INVALID");

console.log(JSON.stringify({ report, blockers }, null, 2));
