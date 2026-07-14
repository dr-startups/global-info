/**
 * Generate arsenkin-db-readiness-v2.json from real test/staging checks.
 *
 * Requires simultaneously:
 *   ARSENKIN_DB_INTEGRATION_REQUIRED=1
 *   ARSENKIN_DB_ENV=test|staging
 *   ARSENKIN_DB_MUTATION_CONFIRM=1
 *
 * Never PASS from env alone. Never logs full DSN or credentials.
 * Positive artifact written atomically only after all checks + verified cleanup.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
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
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
  type DbCheckResult,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

function isPlaceholderDb(url: string): boolean {
  if (!url.trim()) return true;
  if (/postgresql:\/\/u:p@127\.0\.0\.1:5432\/db/i.test(url)) return true;
  if (/postgresql:\/\/user:pass@localhost/i.test(url)) return true;
  if (/postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/postgres/i.test(url)) return true;
  return false;
}

async function main() {
  resetArsenkinNetworkCallCount();
  const outDir = join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p05");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "arsenkin-db-readiness.json");

  const mutation = assertDbMutationAllowed(process.env);
  const build = resolveBuildIdentity(process.env);
  const schemaContentHash = computeSchemaContentHash();
  const sourceTreeHash = computeSourceTreeHash();
  const dbUrl = String(process.env.DATABASE_URL ?? "");
  const fp = fingerprintDatabaseUrl(dbUrl || "postgresql://unknown/unknown");
  const environment = (mutation.environment === "test" || mutation.environment === "staging"
    ? mutation.environment
    : "unknown") as ArsenkinDbReadinessArtifact["environment"];

  const writeFail = (reason: string, extra: Record<string, unknown> = {}) => {
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
    console.error(
      JSON.stringify(
        {
          outPath,
          verdict: "FAIL",
          blockers: [reason],
          fingerprint: fp,
          environment: mutation.environment,
          networkCalls: getArsenkinNetworkCallCount(),
          ...extra,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  };

  if (!mutation.ok) {
    writeFail(mutation.blockers.join(","), { blockers: mutation.blockers });
    return;
  }

  if (isPlaceholderDb(dbUrl)) {
    writeFail("no-real-test-postgresql");
    return;
  }

  const { prisma } = await import("../src/server/prisma/client");
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

    // Full duplicate audit via SQL GROUP BY (not capped at 50k rows).
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

    const { upsertSurfaceCollectionCoverage } = await import(
      "../src/modules/digital-profile/providers/arsenkin/surface-coverage"
    );
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
    console.error(
      JSON.stringify({ phase: "db-readiness-error", error: fatalError, fingerprint: fp }, null, 2)
    );
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
        cleanupError = [
          cleanupError,
          e instanceof Error ? e.message : String(e),
        ]
          .filter(Boolean)
          .join(";");
      }
    }
    await prisma.$disconnect();
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
    build.buildCommit !== "unknown"
      ? "PASS"
      : "FAIL";

  // Never write PASS before all assertions — compute first, then atomic rename.
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
    environment,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 6 * 3600_000).toISOString(),
    cleanupAttempted,
    cleanupOk,
    cleanupRemainingRows: cleanupRemaining,
    cleanupError,
  };
  writeJsonAtomic(outPath, artifact);
  console.log(
    JSON.stringify(
      {
        outPath,
        verdict,
        fingerprint: fp,
        environment,
        migrationApplied,
        uniqueIndexPresent,
        duplicateGroupCount,
        concurrentUpsert,
        backfillRace,
        cleanupAttempted,
        cleanupOk,
        cleanupRemainingRows: cleanupRemaining,
        dirtyTree: build.dirtyTree,
        buildCommit: build.buildCommit === "unknown" ? "unknown" : build.buildCommit.slice(0, 12),
        networkCalls: getArsenkinNetworkCallCount(),
        fatalError,
      },
      null,
      2
    )
  );
  if (verdict !== "PASS") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
