/**
 * Arsenkin DB readiness v2 — fail-closed build/DB identity.
 * Env flags alone never imply PASS. v1 artifacts are rejected.
 */

import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";

export type DbCheckResult = "PASS" | "FAIL";
export type ArsenkinDbEnvironment = "test" | "staging";

export type ArsenkinDbReadinessArtifact = {
  version: string;
  verdict: "PASS" | "FAIL";
  databaseFingerprint: string;
  buildCommit: string;
  buildId: string | null;
  dirtyTree: boolean;
  sourceTreeHash: string;
  schemaContentHash: string;
  /** @deprecated v1 field — rejected by v2 validator when version is v1 */
  schemaChecksum?: string;
  gitCommit?: string;
  requiredMigration: string;
  migrationApplied: boolean;
  uniqueIndexPresent: boolean;
  duplicateGroupCount: number;
  concurrentUpsert: DbCheckResult;
  backfillRace: DbCheckResult;
  environment: ArsenkinDbEnvironment | "unknown" | "production";
  generatedAt: string;
  expiresAt: string;
  cleanupAttempted?: boolean;
  cleanupOk?: boolean;
  cleanupRemainingRows?: {
    coverage: number;
    providerTasks: number;
    reportRuns: number;
  };
  cleanupError?: string | null;
};

export const ARSENKIN_DB_READINESS_VERSION = "arsenkin-db-readiness-v2";
export const REQUIRED_COVERAGE_UNIQUE_MIGRATION =
  "20260714180000_surface_coverage_biz_unique";

export const CRITICAL_LIVE_SOURCE_GLOBS = [
  "scripts/arsenkin-canonical-live-runner.ts",
  "scripts/generate-arsenkin-db-readiness.ts",
  "src/modules/digital-profile/orion-golden/classic/arsenkin-execution-plan.ts",
  "src/modules/digital-profile/orion-golden/classic/arsenkin-canonical-live-gate.ts",
  "src/modules/digital-profile/orion-golden/classic/arsenkin-canary-run-lifecycle.ts",
  "src/modules/digital-profile/orion-golden/classic/arsenkin-client-binding-gate.ts",
  "src/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan.ts",
  "src/modules/digital-profile/orion-golden/classic/arsenkin-stage-ledger.ts",
  "src/modules/digital-profile/orion-golden/classic/execute-canonical-arsenkin-stage.ts",
  "src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness.ts",
  "src/modules/digital-profile/providers/arsenkin/planned-coverage-matrix.ts",
  "src/modules/digital-profile/providers/arsenkin/execute-arsenkin-execution-plan.ts",
  "src/modules/digital-profile/providers/arsenkin/collect-pilot-surfaces.ts",
  "src/modules/digital-profile/providers/arsenkin/client.ts",
  "src/modules/digital-profile/providers/arsenkin/poll-worker.ts",
  "src/modules/digital-profile/providers/arsenkin/live-execution-authorization.ts",
  "src/modules/digital-profile/providers/arsenkin/surface-coverage.ts",
  "src/modules/digital-profile/providers/arsenkin/regions.ts",
  "prisma/schema.prisma",
] as const;

/** Fingerprint protocol/host/port/db/schema/sslmode — never credentials. */
export function fingerprintDatabaseUrl(databaseUrl: string): string {
  let protocol = "unknown";
  let host = "unknown";
  let port = "unknown";
  let db = "unknown";
  let schema = "public";
  let sslmode = "unset";
  try {
    const u = new URL(databaseUrl);
    protocol = (u.protocol || "unknown:").replace(/:$/, "");
    host = u.hostname || "unknown";
    if (u.port) {
      port = u.port;
    } else if (protocol === "postgresql" || protocol === "postgres") {
      port = "5432";
    } else {
      port = "default";
    }
    db = (u.pathname || "/").replace(/^\//, "") || "unknown";
    schema = u.searchParams.get("schema") || "public";
    sslmode = u.searchParams.get("sslmode") || "unset";
  } catch {
    // keep unknowns
  }
  return createHash("sha256")
    .update(JSON.stringify({ protocol, host, port, db, schema, sslmode }))
    .digest("hex")
    .slice(0, 32);
}

function walkMigrationSqlFiles(migrationsRoot: string): string[] {
  if (!existsSync(migrationsRoot)) return [];
  const out: string[] = [];
  for (const name of readdirSync(migrationsRoot).sort()) {
    const dir = join(migrationsRoot, name);
    if (!statSync(dir).isDirectory()) continue;
    const sql = join(dir, "migration.sql");
    if (existsSync(sql)) out.push(sql);
  }
  return out;
}

/** Hash ordered (relPath, bytes) pairs — used by schema hash and mutation tests. */
export function hashOrderedContentEntries(
  entries: ReadonlyArray<{ relPath: string; bytes: Buffer }>
): string {
  const h = createHash("sha256");
  for (const { relPath, bytes } of entries) {
    h.update(relPath.split(sep).join("/"));
    h.update("\0");
    h.update(bytes);
    h.update("\0");
  }
  return h.digest("hex");
}

/** Content hash of schema.prisma + all migration.sql (stable path order, utf-8 bytes). */
export function computeSchemaContentHash(repoRoot: string = process.cwd()): string {
  const schemaPath = join(repoRoot, "prisma", "schema.prisma");
  const files = [
    schemaPath,
    ...walkMigrationSqlFiles(join(repoRoot, "prisma", "migrations")),
  ];
  const entries = files.map((abs) => {
    const rel = relative(repoRoot, abs).split(sep).join("/");
    return {
      relPath: rel,
      bytes: existsSync(abs) ? readFileSync(abs) : Buffer.alloc(0),
    };
  });
  return hashOrderedContentEntries(entries);
}

/**
 * Atomic write: temp file → write → fsync → close → rename.
 * Never leaves a partial destination artifact; cleans up temp on failure.
 */
export function writeJsonAtomic(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  try {
    const data = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    fd = openSync(tmp, "w");
    writeSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    // Best-effort directory fsync on POSIX so rename is durable.
    if (process.platform !== "win32") {
      try {
        const dirFd = openSync(dirname(path), "r");
        try {
          fsyncSync(dirFd);
        } finally {
          closeSync(dirFd);
        }
      } catch {
        // Directory fsync is best-effort; file fsync already completed.
      }
    }
  } catch (err) {
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close after write failure
      }
    }
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }
}

/** Deterministic hash of critical live source files. */
export function computeSourceTreeHash(
  repoRoot: string = process.cwd(),
  files: readonly string[] = CRITICAL_LIVE_SOURCE_GLOBS
): string {
  const h = createHash("sha256");
  for (const rel of [...files].sort()) {
    h.update(rel);
    h.update("\0");
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) h.update(readFileSync(abs));
    h.update("\0");
  }
  return h.digest("hex");
}

export type BuildIdentity = {
  buildCommit: string;
  buildId: string | null;
  dirtyTree: boolean;
  source: "env" | "git" | "unknown";
};

function gitDirPresent(cwd: string = process.cwd()): boolean {
  return existsSync(join(cwd, ".git"));
}

/**
 * Prefer documented CI/deploy SHA; fallback to git.
 * - With .git: clean tree is always required (no dirty bypass).
 * - Without .git: only immutable env SHA is accepted (dirtyTree=false).
 * - Missing both → unknown (blocks live).
 */
export function resolveBuildIdentity(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): BuildIdentity {
  const fromEnv = String(
    env.GITHUB_SHA ||
      env.RAILWAY_GIT_COMMIT_SHA ||
      env.VERCEL_GIT_COMMIT_SHA ||
      env.COMMIT_SHA ||
      env.SOURCE_VERSION ||
      env.ARSENKIN_BUILD_COMMIT ||
      ""
  ).trim();
  const buildId =
    String(env.ARSENKIN_BUILD_ID || env.RAILWAY_DEPLOYMENT_ID || env.GITHUB_RUN_ID || "").trim() ||
    null;
  const hasGit = gitDirPresent(cwd);

  if (fromEnv) {
    if (hasGit) {
      return {
        buildCommit: fromEnv,
        buildId,
        dirtyTree: isGitDirty(cwd),
        source: "env",
      };
    }
    // Immutable CI/deployment image without .git — trust documented SHA only.
    return {
      buildCommit: fromEnv,
      buildId,
      dirtyTree: false,
      source: "env",
    };
  }

  if (hasGit) {
    const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8", cwd });
    const commit = (git.stdout || "").trim();
    if (commit && git.status === 0) {
      return {
        buildCommit: commit,
        buildId,
        dirtyTree: isGitDirty(cwd),
        source: "git",
      };
    }
  }

  return { buildCommit: "unknown", buildId, dirtyTree: true, source: "unknown" };
}

export function isGitDirty(cwd: string = process.cwd()): boolean {
  const r = spawnSync("git", ["status", "--porcelain"], { encoding: "utf-8", cwd });
  if (r.status !== 0) return true;
  return Boolean((r.stdout || "").trim());
}

/** @deprecated use computeSchemaContentHash — kept for transitional tests */
export function schemaChecksumOf(parts: {
  migrationNames: readonly string[];
  uniqueIndexName: string;
}): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
}

export type ValidateDbReadinessInput = {
  artifact: ArsenkinDbReadinessArtifact | null;
  currentFingerprint: string;
  currentBuildCommit: string;
  currentSourceTreeHash: string;
  currentSchemaContentHash: string;
  currentDirtyTree: boolean;
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
    // v1 or other — fail closed without trusting fields
    return { ok: false, blockers };
  }
  if (art.verdict !== "PASS") {
    blockers.push("db-readiness-verdict-not-PASS");
  }
  if (!art.buildCommit || art.buildCommit === "unknown") {
    blockers.push("build-commit-unknown");
  }
  if (input.currentBuildCommit === "unknown" || !input.currentBuildCommit) {
    blockers.push("current-build-commit-unknown");
  }
  if (art.buildCommit !== input.currentBuildCommit) {
    blockers.push("build-commit-mismatch");
  }
  if (art.dirtyTree || input.currentDirtyTree) {
    blockers.push("dirty-source-tree");
  }
  if (art.databaseFingerprint !== input.currentFingerprint) {
    blockers.push("db-fingerprint-mismatch");
  }
  if (art.schemaContentHash !== input.currentSchemaContentHash) {
    blockers.push("schema-content-hash-mismatch");
  }
  if (art.sourceTreeHash !== input.currentSourceTreeHash) {
    blockers.push("source-tree-hash-mismatch");
  }
  if (art.environment !== "test" && art.environment !== "staging") {
    blockers.push(`db-environment-not-allowed:${art.environment}`);
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
  if (art.cleanupAttempted === true && art.cleanupOk === false) {
    blockers.push("db-readiness-cleanup-failed");
  }

  const exp = Date.parse(art.expiresAt);
  if (!Number.isFinite(exp) || !Number.isFinite(now) || now > exp) {
    blockers.push("db-readiness-expired");
  }
  const gen = Date.parse(art.generatedAt);
  if (!Number.isFinite(gen)) blockers.push("db-readiness-generatedAt-invalid");

  return { ok: blockers.length === 0, blockers };
}

export function assertDbMutationAllowed(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  blockers: string[];
  environment: string;
} {
  const blockers: string[] = [];
  if (env.ARSENKIN_DB_INTEGRATION_REQUIRED !== "1") {
    blockers.push("ARSENKIN_DB_INTEGRATION_REQUIRED!=1");
  }
  const dbEnv = String(env.ARSENKIN_DB_ENV ?? "").trim().toLowerCase();
  if (dbEnv !== "test" && dbEnv !== "staging") {
    blockers.push(`ARSENKIN_DB_ENV-not-allowed:${dbEnv || "empty"}`);
  }
  if (env.ARSENKIN_DB_MUTATION_CONFIRM !== "1") {
    blockers.push("ARSENKIN_DB_MUTATION_CONFIRM!=1");
  }
  return { ok: blockers.length === 0, blockers, environment: dbEnv || "empty" };
}

/** Evaluate concurrent backfill race outcomes (pure). Unexpected errors → FAIL. */
export function evaluateBackfillRaceOutcome(input: {
  results: Array<{ count: number; taskId: string; error?: string | null }>;
  expectedTaskIds: readonly [string, string];
  finalProviderTaskId: string | null;
}): DbCheckResult {
  if (input.results.some((r) => r.error)) return "FAIL";
  if (input.results.length !== 2) return "FAIL";
  const counts = input.results.map((r) => r.count).sort();
  if (counts[0] !== 0 || counts[1] !== 1) return "FAIL";
  if (!input.finalProviderTaskId) return "FAIL";
  if (!input.expectedTaskIds.includes(input.finalProviderTaskId)) return "FAIL";
  return "PASS";
}

export function buildDbReadinessFailStub(input: {
  fingerprint: string;
  schemaContentHash: string;
  sourceTreeHash: string;
  buildCommit: string;
  dirtyTree: boolean;
  environment: ArsenkinDbReadinessArtifact["environment"];
  reason: string;
}): ArsenkinDbReadinessArtifact {
  const now = new Date();
  return {
    version: ARSENKIN_DB_READINESS_VERSION,
    verdict: "FAIL",
    databaseFingerprint: input.fingerprint,
    buildCommit: input.buildCommit,
    buildId: null,
    dirtyTree: input.dirtyTree,
    sourceTreeHash: input.sourceTreeHash,
    schemaContentHash: input.schemaContentHash,
    requiredMigration: REQUIRED_COVERAGE_UNIQUE_MIGRATION,
    migrationApplied: false,
    uniqueIndexPresent: false,
    duplicateGroupCount: -1,
    concurrentUpsert: "FAIL",
    backfillRace: "FAIL",
    environment: input.environment,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
    cleanupAttempted: false,
    cleanupOk: true,
    cleanupRemainingRows: { coverage: 0, providerTasks: 0, reportRuns: 0 },
    cleanupError: input.reason,
  };
}

// silence unused import for stream (kept for potential large-file hashing)
void createReadStream;
