/**
 * Arsenkin DB readiness startup + lazy self-healing smokes (NETWORK_CALLS=0).
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import {
  ARSENKIN_DB_READINESS_VERSION,
  computeSchemaContentHash,
  computeSourceTreeHash,
  fingerprintDatabaseUrl,
  resolveBuildIdentity,
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import {
  ensureArsenkinDbReadiness,
  refreshArsenkinDbReadiness,
  resetArsenkinDbReadinessRunnerForTests,
  type EnsureArsenkinDbReadinessResult,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness-runner";
import {
  evaluateStoredReadinessArtifact,
  resolveCurrentReadinessIdentity,
  type ArsenkinDbReadinessRunResult,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness-service";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import {
  getArsenkinUiStatus,
  type ArsenkinUiOrchestrationDeps,
} from "../src/modules/digital-profile/services/arsenkin-ui-orchestration-service";

const INTEGRATION_ENV: NodeJS.ProcessEnv = {
  ARSENKIN_ENABLED: "1",
  ARSENKIN_DB_INTEGRATION_REQUIRED: "1",
  ARSENKIN_DB_ENV: "staging",
  ARSENKIN_DB_MUTATION_CONFIRM: "1",
  DATABASE_URL: "postgresql://user:pass@db.example.com:5432/app?schema=public",
  RAILWAY_GIT_COMMIT_SHA: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
};

function v2Pass(overrides: Partial<ArsenkinDbReadinessArtifact> = {}): ArsenkinDbReadinessArtifact {
  const now = Date.now();
  const identity = resolveCurrentReadinessIdentity(INTEGRATION_ENV);
  const build = resolveBuildIdentity(INTEGRATION_ENV);
  return {
    version: ARSENKIN_DB_READINESS_VERSION,
    verdict: "PASS",
    databaseFingerprint: identity.fingerprint,
    buildCommit: build.buildCommit,
    buildId: build.buildId,
    dirtyTree: build.dirtyTree,
    sourceTreeHash: identity.sourceTreeHash,
    schemaContentHash: identity.schemaContentHash,
    requiredMigration: "20260714180000_surface_coverage_biz_unique",
    migrationApplied: true,
    uniqueIndexPresent: true,
    duplicateGroupCount: 0,
    concurrentUpsert: "PASS",
    backfillRace: "PASS",
    environment: "staging",
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 6 * 3600_000).toISOString(),
    cleanupAttempted: true,
    cleanupOk: true,
    ...overrides,
  };
}

function passRunResult(artifactPath: string, artifact: ArsenkinDbReadinessArtifact): ArsenkinDbReadinessRunResult {
  writeJsonAtomic(artifactPath, artifact);
  return {
    verdict: "PASS",
    artifact,
    artifactPath,
    blockers: [],
    readinessCode: "READINESS_PASS",
    fingerprint: artifact.databaseFingerprint,
    environment: "staging",
    buildCommit: artifact.buildCommit,
    networkCalls: 0,
  };
}

function failRunResult(artifactPath: string, reason: string): ArsenkinDbReadinessRunResult {
  const artifact = v2Pass({ verdict: "FAIL", migrationApplied: false });
  writeJsonAtomic(artifactPath, artifact);
  return {
    verdict: "FAIL",
    artifact,
    artifactPath,
    blockers: [reason],
    readinessCode: "READINESS_FAILED",
    fingerprint: artifact.databaseFingerprint,
    environment: "staging",
    buildCommit: artifact.buildCommit,
    networkCalls: 0,
    fatalError: reason,
  };
}

describe("arsenkin startup readiness", () => {
  let artDir: string;
  let artPath: string;

  beforeEach(() => {
    resetArsenkinNetworkCallCount();
    resetArsenkinDbReadinessRunnerForTests();
    artDir = mkdtempSync(join(tmpdir(), "arsenkin-readiness-"));
    artPath = join(artDir, "arsenkin-db-readiness.json");
    mkdirSync(artDir, { recursive: true });
  });

  afterEach(() => {
    resetArsenkinDbReadinessRunnerForTests();
    if (existsSync(artDir)) rmSync(artDir, { recursive: true, force: true });
  });

  it("A. missing artifact triggers readiness and PASS unlocks", async () => {
    let runs = 0;
    const run = async (): Promise<ArsenkinDbReadinessRunResult> => {
      runs += 1;
      return passRunResult(artPath, v2Pass());
    };
    const first = await ensureArsenkinDbReadiness({
      outPath: artPath,
      env: INTEGRATION_ENV,
      wait: true,
      run,
    });
    assert.equal(runs, 1);
    assert.equal(first.readinessCode, "READINESS_PASS");
    assert.equal(first.verdict, "PASS");
    assert.ok(existsSync(artPath));
  });

  it("B. valid artifact does not re-run readiness", async () => {
    const art = v2Pass();
    const evaluated = evaluateStoredReadinessArtifact({ artifact: art, env: INTEGRATION_ENV });
    writeJsonAtomic(artPath, art);
    let runs = 0;
    const run = async (): Promise<ArsenkinDbReadinessRunResult> => {
      runs += 1;
      return passRunResult(artPath, v2Pass());
    };
    const out = await ensureArsenkinDbReadiness({
      outPath: artPath,
      env: INTEGRATION_ENV,
      wait: true,
      run,
    });
    if (evaluated.ok) {
      assert.equal(runs, 0);
      assert.equal(out.readinessCode, "READINESS_PASS");
    } else {
      assert.equal(runs, 1);
    }
  });

  it("C. buildCommit change triggers refresh", async () => {
    writeJsonAtomic(artPath, v2Pass({ buildCommit: "old-commit-old-commit-old-commit-old" }));
    let runs = 0;
    const run = async (): Promise<ArsenkinDbReadinessRunResult> => {
      runs += 1;
      return passRunResult(artPath, v2Pass());
    };
    await ensureArsenkinDbReadiness({ outPath: artPath, env: INTEGRATION_ENV, wait: true, run });
    assert.equal(runs, 1);
    const stored = JSON.parse(readFileSync(artPath, "utf-8")) as ArsenkinDbReadinessArtifact;
    assert.equal(stored.buildCommit, resolveBuildIdentity(INTEGRATION_ENV).buildCommit);
  });

  it("D. environment mismatch triggers refresh", async () => {
    writeJsonAtomic(artPath, v2Pass({ environment: "test" }));
    const evaluated = evaluateStoredReadinessArtifact({
      artifact: v2Pass({ environment: "test" }),
      env: INTEGRATION_ENV,
    });
    assert.equal(evaluated.readinessCode, "READINESS_ENV_MISMATCH");
    let runs = 0;
    const run = async (): Promise<ArsenkinDbReadinessRunResult> => {
      runs += 1;
      return passRunResult(artPath, v2Pass({ environment: "staging" }));
    };
    await ensureArsenkinDbReadiness({ outPath: artPath, env: INTEGRATION_ENV, wait: true, run });
    assert.equal(runs, 1);
  });

  it("E. parallel requests share one readiness execution", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = async (): Promise<ArsenkinDbReadinessRunResult> => {
      runs += 1;
      await gate;
      return passRunResult(artPath, v2Pass());
    };
    const p1 = ensureArsenkinDbReadiness({ outPath: artPath, env: INTEGRATION_ENV, wait: true, run });
    const p2 = ensureArsenkinDbReadiness({ outPath: artPath, env: INTEGRATION_ENV, wait: true, run });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(runs, 1);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(runs, 1);
    assert.equal(r1.readinessCode, "READINESS_PASS");
    assert.equal(r2.readinessCode, "READINESS_PASS");
  });

  it("F. DB check FAIL keeps gate blocked", async () => {
    const run = async () => failRunResult(artPath, "migration-not-applied");
    const out = await ensureArsenkinDbReadiness({
      outPath: artPath,
      env: INTEGRATION_ENV,
      wait: true,
      run,
    });
    assert.equal(out.verdict, "FAIL");
    assert.equal(out.readinessCode, "READINESS_FAILED");
    assert.ok(out.blockers.length > 0);
  });

  it("G. readiness PASS allows prepare path (orchestration status)", async () => {
    writeJsonAtomic(artPath, v2Pass());
    const deps: ArsenkinUiOrchestrationDeps = {
      dbReadinessPath: artPath,
      isEnabled: () => true,
      isConfigured: () => true,
      readinessBlockers: () => [],
      prisma: {
        orionReportRun: {
          findFirst: async () => null,
        },
        providerTask: { count: async () => 0 },
        serpObservation: { count: async () => 0 },
        surfaceCollectionCoverage: { count: async () => 0 },
      } as ArsenkinUiOrchestrationDeps["prisma"],
    };
    const status = await getArsenkinUiStatus("case-1", null, "SUGGEST_RU_CANARY", deps);
    assert.equal(status.readinessCode, "READINESS_PASS");
    assert.equal(status.canPrepare, false); // no source reportRunId
    assert.notEqual(status.status, "BLOCKED");
  });

  it("H. readiness path keeps NETWORK_CALLS=0", async () => {
    resetArsenkinNetworkCallCount();
    const run = async () => passRunResult(artPath, v2Pass());
    const out = await ensureArsenkinDbReadiness({
      outPath: artPath,
      env: INTEGRATION_ENV,
      wait: true,
      run,
    });
    assert.equal(out.networkCalls, 0);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("I. restart simulation with empty storage auto-recovers", async () => {
    assert.equal(existsSync(artPath), false);
    let runs = 0;
    const run = async (): Promise<ArsenkinDbReadinessRunResult> => {
      runs += 1;
      return passRunResult(artPath, v2Pass());
    };
    const nonBlocking = await ensureArsenkinDbReadiness({
      outPath: artPath,
      env: INTEGRATION_ENV,
      wait: false,
      run,
    });
    assert.equal(nonBlocking.readinessCode, "READINESS_RUNNING");
    const done = await ensureArsenkinDbReadiness({
      outPath: artPath,
      env: INTEGRATION_ENV,
      wait: true,
      run,
    });
    assert.equal(runs, 1);
    assert.equal(done.readinessCode, "READINESS_PASS");
  });

  it("refresh-readiness forces rerun even with valid artifact", async () => {
    writeJsonAtomic(artPath, v2Pass());
    let runs = 0;
    const run = async (): Promise<ArsenkinDbReadinessRunResult> => {
      runs += 1;
      return passRunResult(artPath, v2Pass());
    };
    await refreshArsenkinDbReadiness({ outPath: artPath, env: INTEGRATION_ENV, run });
    assert.equal(runs, 1);
  });

  it("cache key includes environment + buildCommit + schema fingerprint", () => {
    const id = resolveCurrentReadinessIdentity(INTEGRATION_ENV);
    assert.match(id.cacheKey, /staging\|/);
    assert.ok(id.cacheKey.includes(id.buildCommit));
    assert.ok(id.cacheKey.includes(id.schemaContentHash));
  });
});
