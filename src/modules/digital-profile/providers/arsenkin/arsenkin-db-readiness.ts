/**
 * DB readiness artifact schema + pure validators for canonical live runner.
 * Env flags alone never imply PASS.
 */

import { createHash } from "node:crypto";

export type DbCheckResult = "PASS" | "FAIL";

export type ArsenkinDbReadinessArtifact = {
  version: string;
  verdict: "PASS" | "FAIL";
  databaseFingerprint: string;
  schemaChecksum: string;
  gitCommit: string;
  requiredMigration: string;
  migrationApplied: boolean;
  uniqueIndexPresent: boolean;
  duplicateGroupCount: number;
  concurrentUpsert: DbCheckResult;
  backfillRace: DbCheckResult;
  generatedAt: string;
  expiresAt: string;
};

export const ARSENKIN_DB_READINESS_VERSION = "arsenkin-db-readiness-v1";
export const REQUIRED_COVERAGE_UNIQUE_MIGRATION =
  "20260714180000_surface_coverage_biz_unique";

/** Fingerprint host/db/schema only — strip credentials from DATABASE_URL. */
export function fingerprintDatabaseUrl(databaseUrl: string): string {
  let host = "unknown";
  let db = "unknown";
  let schema = "public";
  try {
    const u = new URL(databaseUrl);
    host = u.hostname || "unknown";
    db = (u.pathname || "/").replace(/^\//, "") || "unknown";
    schema = u.searchParams.get("schema") || "public";
  } catch {
    // keep unknowns
  }
  return createHash("sha256")
    .update(JSON.stringify({ host, db, schema }))
    .digest("hex")
    .slice(0, 32);
}

export function schemaChecksumOf(parts: {
  migrationNames: readonly string[];
  uniqueIndexName: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 32);
}

export type ValidateDbReadinessInput = {
  artifact: ArsenkinDbReadinessArtifact | null;
  currentFingerprint: string;
  currentGitCommit: string;
  currentSchemaChecksum: string;
  nowIso?: string;
  requiredMigration?: string;
};

export type ValidateDbReadinessResult = {
  ok: boolean;
  blockers: string[];
};

export function validateDbReadinessArtifact(
  input: ValidateDbReadinessInput
): ValidateDbReadinessResult {
  const blockers: string[] = [];
  const art = input.artifact;
  const required = input.requiredMigration ?? REQUIRED_COVERAGE_UNIQUE_MIGRATION;
  const now = Date.parse(input.nowIso ?? new Date().toISOString());

  if (!art) {
    return { ok: false, blockers: ["db-readiness-artifact-missing"] };
  }
  if (art.version !== ARSENKIN_DB_READINESS_VERSION) {
    blockers.push("db-readiness-version-mismatch");
  }
  if (art.verdict !== "PASS") {
    blockers.push("db-readiness-verdict-not-PASS");
  }
  if (art.databaseFingerprint !== input.currentFingerprint) {
    blockers.push("db-fingerprint-mismatch");
  }
  if (art.schemaChecksum !== input.currentSchemaChecksum) {
    blockers.push("schema-checksum-mismatch");
  }
  if (art.gitCommit && input.currentGitCommit && art.gitCommit !== input.currentGitCommit) {
    // Soft: allow when artifact commit differs but document — still block for live safety.
    blockers.push("git-commit-mismatch");
  }
  if (art.requiredMigration !== required) {
    blockers.push("required-migration-mismatch");
  }
  if (!art.migrationApplied) blockers.push("migration-not-applied");
  if (!art.uniqueIndexPresent) blockers.push("unique-index-absent");
  if (art.duplicateGroupCount !== 0) {
    blockers.push(`duplicate-groups:${art.duplicateGroupCount}`);
  }
  if (art.concurrentUpsert !== "PASS") blockers.push("concurrent-upsert-not-PASS");
  if (art.backfillRace !== "PASS") blockers.push("backfill-race-not-PASS");

  const exp = Date.parse(art.expiresAt);
  if (!Number.isFinite(exp) || !Number.isFinite(now) || now > exp) {
    blockers.push("db-readiness-expired");
  }
  const gen = Date.parse(art.generatedAt);
  if (!Number.isFinite(gen)) blockers.push("db-readiness-generatedAt-invalid");

  return { ok: blockers.length === 0, blockers };
}

/** Build FAIL artifact when checks incomplete — never invent PASS from env. */
export function buildDbReadinessFailStub(input: {
  fingerprint: string;
  schemaChecksum: string;
  gitCommit: string;
  reason: string;
}): ArsenkinDbReadinessArtifact {
  const now = new Date();
  return {
    version: ARSENKIN_DB_READINESS_VERSION,
    verdict: "FAIL",
    databaseFingerprint: input.fingerprint,
    schemaChecksum: input.schemaChecksum,
    gitCommit: input.gitCommit,
    requiredMigration: REQUIRED_COVERAGE_UNIQUE_MIGRATION,
    migrationApplied: false,
    uniqueIndexPresent: false,
    duplicateGroupCount: -1,
    concurrentUpsert: "FAIL",
    backfillRace: "FAIL",
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
  };
}
