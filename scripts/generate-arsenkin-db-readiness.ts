/**
 * Generate arsenkin-db-readiness-v2.json from real test/staging checks.
 *
 * Requires simultaneously:
 *   ARSENKIN_DB_INTEGRATION_REQUIRED=1
 *   ARSENKIN_DB_ENV=test|staging
 *   ARSENKIN_DB_MUTATION_CONFIRM=1
 *
 * Never PASS from env alone. Never logs full DSN or credentials.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
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
  type ArsenkinDbReadinessArtifact,
  type DbCheckResult,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import { findSurfaceCoverageDuplicateGroups } from "../src/modules/digital-profile/providers/arsenkin/surface-coverage-duplicate-audit";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

function isPlaceholderDb(url: string): boolean {
  if (!url.trim()) return true;
  if (/postgresql:\/\/u:p@127\.0\.0\.1:5432\/db/i.test(url)) return true;
  if (/postgresql:\/\/user:pass@localhost/i.test(url)) return true;
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

  if (!mutation.ok) {
    const stub = buildDbReadinessFailStub({
      fingerprint: fp,
      schemaContentHash,
      sourceTreeHash,
      buildCommit: build.buildCommit,
      dirtyTree: build.dirtyTree,
      environment: environment === "unknown" ? "unknown" : environment,
      reason: mutation.blockers.join(","),
    });
    writeFileSync(outPath, `${JSON.stringify(stub, null, 2)}\n`);
    console.error(
      JSON.stringify(
        {
          outPath,
          verdict: "FAIL",
          blockers: mutation.blockers,
          fingerprint: fp,
          environment: mutation.environment,
          networkCalls: getArsenkinNetworkCallCount(),
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  if (isPlaceholderDb(dbUrl)) {
    const stub = buildDbReadinessFailStub({
      fingerprint: fp,
      schemaContentHash,
      sourceTreeHash,
      buildCommit: build.buildCommit,
      dirtyTree: build.dirtyTree,
      environment,
      reason: "no-real-test-postgresql",
    });
    writeFileSync(outPath, `${JSON.stringify(stub, null, 2)}\n`);
    console.log(JSON.stringify({ outPath, verdict: stub.verdict, reason: "no-real-test-postgresql", fingerprint: fp }, null, 2));
    process.exitCode = 1;
    return;
  }

  const { prisma } = await import("../src/server/prisma/client");
  let migrationApplied = false;
  let uniqueIndexPresent = false;
  let duplicateGroupCount = -1;
  let concurrentUpsert: DbCheckResult = "FAIL";
  let backfillRace: DbCheckResult = "FAIL";
  let cleanupOk = true;
  let reportRunId: string | null = null;

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

    const rows = await prisma.surfaceCollectionCoverage.findMany({
      select: {
        id: true,
        reportRunId: true,
        provider: true,
        tool: true,
        queryId: true,
        surface: true,
        engine: true,
        region: true,
        language: true,
        device: true,
      },
      take: 50_000,
    });
    duplicateGroupCount = findSurfaceCoverageDuplicateGroups(rows).duplicateGroupCount;

    const caseRow = await prisma.case.findFirst({ select: { id: true } });
    if (!caseRow) {
      throw new Error("no-Case-row-for-db-readiness");
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

    // Reset link for race
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
    const message = e instanceof Error ? e.message : String(e);
    backfillRace = "FAIL";
    concurrentUpsert = concurrentUpsert === "PASS" ? concurrentUpsert : "FAIL";
    console.error(JSON.stringify({ phase: "db-readiness-error", error: message, fingerprint: fp }, null, 2));
  } finally {
    if (reportRunId) {
      try {
        await prisma.surfaceCollectionCoverage.deleteMany({ where: { reportRunId } });
        await prisma.providerTask.deleteMany({ where: { reportRunId } });
        await prisma.orionReportRun.delete({ where: { id: reportRunId } }).catch(() => undefined);
      } catch {
        cleanupOk = false;
      }
    }
    await prisma.$disconnect().catch(() => undefined);
  }

  const now = new Date();
  const verdict: "PASS" | "FAIL" =
    migrationApplied &&
    uniqueIndexPresent &&
    duplicateGroupCount === 0 &&
    concurrentUpsert === "PASS" &&
    backfillRace === "PASS" &&
    cleanupOk &&
    !build.dirtyTree &&
    build.buildCommit !== "unknown"
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
    environment,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 6 * 3600_000).toISOString(),
  };
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
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
        cleanupOk,
        dirtyTree: build.dirtyTree,
        buildCommit: build.buildCommit === "unknown" ? "unknown" : build.buildCommit.slice(0, 12),
        networkCalls: getArsenkinNetworkCallCount(),
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
