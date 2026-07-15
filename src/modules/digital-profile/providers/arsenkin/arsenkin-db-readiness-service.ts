/**
 * Reusable Arsenkin DB readiness runner — shared by CLI, container startup, and lazy UI refresh.
 * Never calls Arsenkin HTTP API. NETWORK_CALLS must remain 0.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/server/prisma/client";
import {
  ARSENKIN_DB_READINESS_VERSION,
  REQUIRED_COVERAGE_UNIQUE_MIGRATION,
  assertDbMutationAllowed,
  buildDbReadinessFailStub,
  computeSchemaContentHash,
  computeSourceTreeHash,
  evaluateBackfillRaceOutcome,
  fingerprintDatabaseUrl,
  resolveBuildIdentity,
  validateDbReadinessArtifact,
  writeJsonAtomic,
  type ArsenkinDbEnvironment,
  type ArsenkinDbReadinessArtifact,
  type DbCheckResult,
  type ValidateDbReadinessResult,
} from "./arsenkin-db-readiness";
import { getArsenkinNetworkCallCount, resetArsenkinNetworkCallCount } from "./network-guard";

export const DEFAULT_ARSENKIN_DB_READINESS_PATH = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-arsenkin-p05",
  "arsenkin-db-readiness.json"
);

export type ArsenkinReadinessCode =
  | "READINESS_PASS"
  | "READINESS_RUNNING"
  | "READINESS_ARTIFACT_MISSING"
  | "READINESS_STALE_BUILD"
  | "READINESS_ENV_MISMATCH"
  | "READINESS_FAILED"
  | "READINESS_SKIPPED"
  | "READINESS_NOT_REQUIRED";

export type ArsenkinDbReadinessRunResult = {
  verdict: "PASS" | "FAIL" | "SKIPPED";
  artifact: ArsenkinDbReadinessArtifact | null;
  artifactPath: string;
  blockers: string[];
  readinessCode: ArsenkinReadinessCode;
  fingerprint: string;
  environment: string;
  buildCommit: string;
  networkCalls: number;
  skippedReason?: string;
  fatalError?: string | null;
};

export type CurrentReadinessIdentity = {
  fingerprint: string;
  buildCommit: string;
  sourceTreeHash: string;
  schemaContentHash: string;
  dirtyTree: boolean;
  environment: string;
  cacheKey: string;
};

function isPlaceholderDb(url: string): boolean {
  if (!url.trim()) return true;
  if (/postgresql:\/\/u:p@127\.0\.0\.1:5432\/db/i.test(url)) return true;
  if (/postgresql:\/\/user:pass@localhost/i.test(url)) return true;
  if (/postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/postgres/i.test(url)) return true;
  return false;
}

export function getDefaultReadinessArtifactPath(
  cwd: string = process.cwd()
): string {
  return join(cwd, "storage", "digital-profile", "qa-arsenkin-p05", "arsenkin-db-readiness.json");
}

/** Whether container startup should attempt DB readiness before serving traffic. */
export function shouldRunStartupDbReadiness(env: NodeJS.ProcessEnv = process.env): boolean {
  const arsenkinOn = env.ARSENKIN_ENABLED === "1" || env.ARSENKIN_ENABLED === "true";
  if (!arsenkinOn) return false;
  return env.ARSENKIN_DB_INTEGRATION_REQUIRED === "1";
}

/** Whether DB readiness checks should execute (CLI always checks when integration flag set). */
export function shouldExecuteDbReadinessChecks(
  env: NodeJS.ProcessEnv = process.env,
  input?: { forCli?: boolean }
): boolean {
  if (input?.forCli) {
    return env.ARSENKIN_DB_INTEGRATION_REQUIRED === "1";
  }
  return shouldRunStartupDbReadiness(env);
}

export function resolveCurrentReadinessIdentity(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): CurrentReadinessIdentity {
  const mutation = assertDbMutationAllowed(env);
  const build = resolveBuildIdentity(env, cwd);
  const schemaContentHash = computeSchemaContentHash(cwd);
  const sourceTreeHash = computeSourceTreeHash(cwd);
  const dbUrl = String(env.DATABASE_URL ?? "");
  const fingerprint = fingerprintDatabaseUrl(dbUrl || "postgresql://unknown/unknown");
  const cacheKey = [
    mutation.environment,
    build.buildCommit,
    schemaContentHash,
    fingerprint,
  ].join("|");
  return {
    fingerprint,
    buildCommit: build.buildCommit,
    sourceTreeHash,
    schemaContentHash,
    dirtyTree: build.dirtyTree,
    environment: mutation.environment,
    cacheKey,
  };
}

export function evaluateStoredReadinessArtifact(input: {
  artifact: ArsenkinDbReadinessArtifact | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  nowIso?: string;
}): ValidateDbReadinessResult & { readinessCode: ArsenkinReadinessCode } {
  const identity = resolveCurrentReadinessIdentity(input.env, input.cwd);
  if (!input.artifact) {
    return { ok: false, blockers: ["db-readiness-artifact-missing"], readinessCode: "READINESS_ARTIFACT_MISSING" };
  }
  const r = validateDbReadinessArtifact({
    artifact: input.artifact,
    currentFingerprint: identity.fingerprint,
    currentBuildCommit: identity.buildCommit,
    currentSourceTreeHash: identity.sourceTreeHash,
    currentSchemaContentHash: identity.schemaContentHash,
    currentDirtyTree: identity.dirtyTree,
    currentEnvironment: identity.environment,
    nowIso: input.nowIso,
  });
  let readinessCode: ArsenkinReadinessCode = r.ok ? "READINESS_PASS" : "READINESS_FAILED";
  if (!r.ok) {
    if (r.blockers.includes("db-readiness-artifact-missing")) {
      readinessCode = "READINESS_ARTIFACT_MISSING";
    } else if (r.blockers.some((b) => /build-commit-mismatch|source-tree-hash-mismatch|schema-content-hash-mismatch|db-readiness-expired/.test(b))) {
      readinessCode = "READINESS_STALE_BUILD";
    } else if (r.blockers.some((b) => /db-environment-not-allowed|db-fingerprint-mismatch|db-readiness-environment-mismatch/.test(b))) {
      readinessCode = "READINESS_ENV_MISMATCH";
    }
  }
  return { ...r, readinessCode };
}

export function artifactNeedsRefresh(input: {
  artifact: ArsenkinDbReadinessArtifact | null;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  nowIso?: string;
}): boolean {
  const evaluated = evaluateStoredReadinessArtifact(input);
  return !evaluated.ok;
}

export function mapReadinessBlockersToCode(blockers: string[]): ArsenkinReadinessCode {
  if (blockers.length === 0) return "READINESS_PASS";
  if (blockers.includes("db-readiness-artifact-missing")) return "READINESS_ARTIFACT_MISSING";
  if (blockers.some((b) => /build-commit-mismatch|source-tree-hash-mismatch|schema-content-hash-mismatch|db-readiness-expired/.test(b))) {
    return "READINESS_STALE_BUILD";
  }
  if (blockers.some((b) => /db-environment-not-allowed|db-fingerprint-mismatch|db-readiness-environment-mismatch/.test(b))) {
    return "READINESS_ENV_MISMATCH";
  }
  return "READINESS_FAILED";
}

export function humanizeReadinessCode(
  code: ArsenkinReadinessCode,
  blockers: string[] = []
): string {
  switch (code) {
    case "READINESS_PASS":
      return "READINESS_PASS: проверка БД пройдена.";
    case "READINESS_RUNNING":
      return "READINESS_RUNNING: выполняется проверка готовности БД…";
    case "READINESS_ARTIFACT_MISSING":
      return "READINESS_ARTIFACT_MISSING: артефакт готовности БД отсутствует — требуется проверка.";
    case "READINESS_STALE_BUILD":
      return "READINESS_STALE_BUILD: артефакт устарел после деплоя — требуется повторная проверка.";
    case "READINESS_ENV_MISMATCH":
      return "READINESS_ENV_MISMATCH: артефакт не соответствует текущей среде БД.";
    case "READINESS_SKIPPED":
      return "READINESS_SKIPPED: автоматическая проверка БД не требуется в этой среде.";
    case "READINESS_NOT_REQUIRED":
      return "READINESS_NOT_REQUIRED: интеграция БД Arsenkin не включена.";
    case "READINESS_FAILED":
    default:
      return `READINESS_FAILED: ${blockers[0] ?? "проверка БД не пройдена"}`;
  }
}

export type RunArsenkinDbReadinessOptions = {
  outPath?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  prisma?: PrismaClient;
  resetNetworkGuard?: boolean;
  /** CLI invocation — runs when ARSENKIN_DB_INTEGRATION_REQUIRED=1 even if ARSENKIN_ENABLED is off. */
  forCli?: boolean;
};

/**
 * Execute full DB readiness checks and atomically write the artifact.
 * Shared implementation for CLI, startup runner, and lazy server refresh.
 */
export async function runArsenkinDbReadiness(
  options: RunArsenkinDbReadinessOptions = {}
): Promise<ArsenkinDbReadinessRunResult> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const outPath = options.outPath ?? getDefaultReadinessArtifactPath(cwd);
  if (options.resetNetworkGuard !== false) resetArsenkinNetworkCallCount();

  mkdirSync(join(cwd, "storage", "digital-profile", "qa-arsenkin-p05"), { recursive: true });

  const mutation = assertDbMutationAllowed(env);
  const build = resolveBuildIdentity(env, cwd);
  const schemaContentHash = computeSchemaContentHash(cwd);
  const sourceTreeHash = computeSourceTreeHash(cwd);
  const dbUrl = String(env.DATABASE_URL ?? "");
  const fp = fingerprintDatabaseUrl(dbUrl || "postgresql://unknown/unknown");
  const environment = (mutation.environment === "test" || mutation.environment === "staging"
    ? mutation.environment
    : "unknown") as ArsenkinDbReadinessArtifact["environment"];

  const writeFail = (reason: string, blockers: string[] = [reason]) => {
    const stub = buildDbReadinessFailStub({
      fingerprint: fp,
      schemaContentHash,
      sourceTreeHash,
      buildCommit: build.buildCommit,
      dirtyTree: build.dirtyTree,
      environment: environment === "unknown" ? "unknown" : environment,
      reason,
    });
    writeJsonAtomic(outPath, stub);
    return {
      verdict: "FAIL" as const,
      artifact: stub,
      artifactPath: outPath,
      blockers,
      readinessCode: mapReadinessBlockersToCode(blockers),
      fingerprint: fp,
      environment: mutation.environment,
      buildCommit: build.buildCommit,
      networkCalls: getArsenkinNetworkCallCount(),
      fatalError: reason,
    };
  };

  if (!shouldExecuteDbReadinessChecks(env, { forCli: options.forCli })) {
    return {
      verdict: "SKIPPED",
      artifact: null,
      artifactPath: outPath,
      blockers: [],
      readinessCode: "READINESS_SKIPPED",
      fingerprint: fp,
      environment: mutation.environment,
      buildCommit: build.buildCommit,
      networkCalls: getArsenkinNetworkCallCount(),
      skippedReason: "ARSENKIN_DB_INTEGRATION_REQUIRED!=1",
    };
  }

  if (!mutation.ok) {
    return writeFail(mutation.blockers.join(","), mutation.blockers);
  }

  if (isPlaceholderDb(dbUrl)) {
    return writeFail("no-real-test-postgresql", ["no-real-test-postgresql"]);
  }

  const prisma: PrismaClient = options.prisma ?? defaultPrisma;

  let migrationApplied = false;
  let uniqueIndexPresent = false;
  let duplicateGroupCount = -1;
  let concurrentUpsert: DbCheckResult = "FAIL";
  let backfillRace: DbCheckResult = "FAIL";
  let cleanupAttempted = false;
  let cleanupOk = true;
  let cleanupError: string | null = null;
  let cleanupRemaining = { coverage: -1, providerTasks: -1, reportRuns: -1 };
  let ephemeralCaseId: string | null = null;
  let reportRunId: string | null = null;
  let fatalError: string | null = null;

  try {
    await prisma.$queryRaw`SELECT 1`;

    const mig = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT migration_name FROM "_prisma_migrations" WHERE migration_name = $1 LIMIT 1`,
      REQUIRED_COVERAGE_UNIQUE_MIGRATION
    ).catch(() => []);
    migrationApplied = mig.length > 0;

    const idx = await prisma.$queryRawUnsafe<Array<{ indexname: string }>>(
      `SELECT indexname FROM pg_indexes WHERE indexname = 'dp_surface_coverage_biz_unique' LIMIT 1`
    ).catch(() => []);
    uniqueIndexPresent = idx.length > 0;

    const dupRows = await prisma.$queryRawUnsafe<Array<{ cnt: bigint | number }>>(
      `SELECT COUNT(*)::int AS cnt FROM (
         SELECT 1
         FROM "dp_surface_collection_coverage"
         GROUP BY "reportRunId", provider, tool, "queryId", surface, engine, region, language, device
         HAVING COUNT(*) > 1
       ) d`
    ).catch(() => [{ cnt: -1 }]);
    duplicateGroupCount = Number(dupRows[0]?.cnt ?? -1);

    let caseRow = await prisma.case.findFirst({ select: { id: true } });
    if (!caseRow) {
      ephemeralCaseId = `p05-case-${randomUUID().slice(0, 8)}`;
      await prisma.case.create({
        data: {
          id: ephemeralCaseId,
          caseNumber: `P05-${Date.now()}`,
          title: "Arsenkin DB readiness ephemeral",
          createdBy: "arsenkin-db-readiness",
        },
      });
      caseRow = { id: ephemeralCaseId };
    }

    reportRunId = `p05-cov-${Date.now()}`;
    await prisma.orionReportRun.create({
      data: { id: reportRunId, caseId: caseRow.id, status: "RUNNING", mode: "db-readiness-v2" },
    });

    const { upsertSurfaceCollectionCoverage } = await import("./surface-coverage");
    const payload = {
      reportRunId,
      provider: "arsenkin",
      tool: "suggest",
      queryId: "p05-q",
      queryText: "test",
      engine: "GOOGLE",
      region: "RU",
      language: "ru",
      device: "DESKTOP",
      surface: "autocomplete",
      resultCount: 0,
    };
    await Promise.all([
      upsertSurfaceCollectionCoverage(payload),
      upsertSurfaceCollectionCoverage({ ...payload, resultCount: 1 }),
      upsertSurfaceCollectionCoverage({ ...payload, resultCount: 2 }),
    ]);
    const n = await prisma.surfaceCollectionCoverage.count({
      where: { reportRunId, queryId: "p05-q" },
    });
    concurrentUpsert = n === 1 ? "PASS" : "FAIL";

    const cov = await prisma.surfaceCollectionCoverage.findFirst({
      where: { reportRunId, queryId: "p05-q" },
    });
    if (!cov) throw new Error("coverage-row-missing-after-upsert");

    await prisma.surfaceCollectionCoverage.update({
      where: { id: cov.id },
      data: { providerTaskId: null },
    });

    const taskA = `p05-task-a-${randomUUID().slice(0, 8)}`;
    const taskB = `p05-task-b-${randomUUID().slice(0, 8)}`;
    const hashBase = createHash("sha256").update(reportRunId).digest("hex");
    await prisma.providerTask.createMany({
      data: [
        {
          id: taskA,
          caseId: caseRow.id,
          reportRunId,
          provider: "arsenkin",
          toolName: "suggest",
          requestHash: `${hashBase}a`,
          requestJson: { tools_name: "suggest", data: { q: "a" } },
          state: "DONE",
          externalTaskId: "ext-a",
          responseJson: { ok: true },
        },
        {
          id: taskB,
          caseId: caseRow.id,
          reportRunId,
          provider: "arsenkin",
          toolName: "suggest",
          requestHash: `${hashBase}b`,
          requestJson: { tools_name: "suggest", data: { q: "b" } },
          state: "DONE",
          externalTaskId: "ext-b",
          responseJson: { ok: true },
        },
      ],
    });

    const raceOne = async (taskId: string) => {
      try {
        const updated = await prisma.surfaceCollectionCoverage.updateMany({
          where: { id: cov.id, providerTaskId: null },
          data: { providerTaskId: taskId },
        });
        return { count: updated.count, taskId, error: null as string | null };
      } catch (e) {
        return {
          count: -1,
          taskId,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    };

    const [r1, r2] = await Promise.all([raceOne(taskA), raceOne(taskB)]);
    const final = await prisma.surfaceCollectionCoverage.findUnique({ where: { id: cov.id } });
    backfillRace = evaluateBackfillRaceOutcome({
      results: [r1, r2],
      expectedTaskIds: [taskA, taskB],
      finalProviderTaskId: final?.providerTaskId ?? null,
    });
  } catch (e) {
    fatalError = e instanceof Error ? e.message : String(e);
    backfillRace = "FAIL";
    concurrentUpsert = concurrentUpsert === "PASS" ? concurrentUpsert : "FAIL";
  } finally {
    cleanupAttempted = Boolean(reportRunId) || Boolean(ephemeralCaseId);
    if (reportRunId) {
      try {
        await prisma.surfaceCollectionCoverage.deleteMany({ where: { reportRunId } });
        await prisma.providerTask.deleteMany({ where: { reportRunId } });
        await prisma.orionArsenkinStageRun.deleteMany({ where: { reportRunId } });
        await prisma.orionReportRun.delete({ where: { id: reportRunId } });
        const [c, t, r] = await Promise.all([
          prisma.surfaceCollectionCoverage.count({ where: { reportRunId } }),
          prisma.providerTask.count({ where: { reportRunId } }),
          prisma.orionReportRun.count({ where: { id: reportRunId } }),
        ]);
        cleanupRemaining = { coverage: c, providerTasks: t, reportRuns: r };
        if (c !== 0 || t !== 0 || r !== 0) {
          cleanupOk = false;
          cleanupError = `remaining-rows:coverage=${c}:tasks=${t}:runs=${r}`;
        }
      } catch (e) {
        cleanupOk = false;
        cleanupError = e instanceof Error ? e.message : String(e);
      }
    }
    if (ephemeralCaseId) {
      try {
        await prisma.case.delete({ where: { id: ephemeralCaseId } });
      } catch (e) {
        cleanupOk = false;
        cleanupError = [cleanupError, e instanceof Error ? e.message : String(e)].filter(Boolean).join(";");
      }
    }
    if (!options.prisma) {
      await prisma.$disconnect();
    }
  }

  const now = new Date();
  const verdict: "PASS" | "FAIL" =
    !fatalError &&
    migrationApplied &&
    uniqueIndexPresent &&
    duplicateGroupCount === 0 &&
    concurrentUpsert === "PASS" &&
    backfillRace === "PASS" &&
    cleanupAttempted &&
    cleanupOk &&
    !build.dirtyTree &&
    build.buildCommit !== "unknown" &&
    environment === mutation.environment
      ? "PASS"
      : "FAIL";

  const artifact: ArsenkinDbReadinessArtifact = {
    version: ARSENKIN_DB_READINESS_VERSION,
    verdict,
    databaseFingerprint: fp,
    buildCommit: build.buildCommit,
    buildId: build.buildId,
    dirtyTree: build.dirtyTree,
    sourceTreeHash,
    schemaContentHash,
    requiredMigration: REQUIRED_COVERAGE_UNIQUE_MIGRATION,
    migrationApplied,
    uniqueIndexPresent,
    duplicateGroupCount,
    concurrentUpsert,
    backfillRace,
    environment: environment === "unknown" ? "unknown" : environment,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 6 * 3600_000).toISOString(),
    cleanupAttempted,
    cleanupOk,
    cleanupRemainingRows: cleanupRemaining,
    cleanupError,
  };

  writeJsonAtomic(outPath, artifact);

  const blockers: string[] = [];
  if (verdict !== "PASS") {
    if (fatalError) blockers.push(fatalError);
    if (!migrationApplied) blockers.push("migration-not-applied");
    if (!uniqueIndexPresent) blockers.push("unique-index-absent");
    if (duplicateGroupCount !== 0) blockers.push(`duplicate-groups:${duplicateGroupCount}`);
    if (concurrentUpsert !== "PASS") blockers.push("concurrent-upsert-not-PASS");
    if (backfillRace !== "PASS") blockers.push("backfill-race-not-PASS");
    if (!cleanupOk) blockers.push("db-readiness-cleanup-failed");
    if (build.dirtyTree) blockers.push("dirty-source-tree");
    if (build.buildCommit === "unknown") blockers.push("build-commit-unknown");
    if (environment !== mutation.environment) blockers.push(`db-environment-not-allowed:${environment}`);
    if (blockers.length === 0) blockers.push("db-readiness-verdict-not-PASS");
  }

  const evaluated = evaluateStoredReadinessArtifact({ artifact, env, cwd, nowIso: now.toISOString() });
  const readinessCode =
    verdict === "PASS" && evaluated.ok ? "READINESS_PASS" : mapReadinessBlockersToCode(evaluated.blockers.length ? evaluated.blockers : blockers);

  return {
    verdict,
    artifact,
    artifactPath: outPath,
    blockers: evaluated.blockers.length ? evaluated.blockers : blockers,
    readinessCode,
    fingerprint: fp,
    environment: mutation.environment,
    buildCommit: build.buildCommit,
    networkCalls: getArsenkinNetworkCallCount(),
    fatalError,
  };
}
