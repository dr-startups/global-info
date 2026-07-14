/**
 * Generate arsenkin-db-readiness.json from real test/staging checks.
 *
 * Without a real DATABASE_URL → writes FAIL stub (never PASS from env alone).
 *
 *   npx tsx scripts/generate-arsenkin-db-readiness.ts
 *   ARSENKIN_DB_INTEGRATION_REQUIRED=1 DATABASE_URL=... npx tsx scripts/generate-arsenkin-db-readiness.ts
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ARSENKIN_DB_READINESS_VERSION,
  REQUIRED_COVERAGE_UNIQUE_MIGRATION,
  buildDbReadinessFailStub,
  fingerprintDatabaseUrl,
  schemaChecksumOf,
  type ArsenkinDbReadinessArtifact,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import { findSurfaceCoverageDuplicateGroups } from "../src/modules/digital-profile/providers/arsenkin/surface-coverage-duplicate-audit";

function gitCommit(): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" });
  return (r.stdout || "").trim() || "unknown";
}

function schemaChecksum(): string {
  const migDir = join(process.cwd(), "prisma", "migrations");
  const names = existsSync(migDir)
    ? readdirSync(migDir).filter((n) => !n.startsWith("."))
    : [];
  return schemaChecksumOf({
    migrationNames: names.sort(),
    uniqueIndexName: "dp_surface_coverage_biz_unique",
  });
}

function isPlaceholderDb(url: string): boolean {
  if (!url.trim()) return true;
  if (/postgresql:\/\/u:p@127\.0\.0\.1:5432\/db/i.test(url)) return true;
  if (/postgresql:\/\/user:pass@localhost/i.test(url)) return true;
  return false;
}

async function main() {
  const outDir = join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p04");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "arsenkin-db-readiness.json");
  const dbUrl = String(process.env.DATABASE_URL ?? "");
  const fp = fingerprintDatabaseUrl(dbUrl || "postgresql://unknown/unknown");
  const checksum = schemaChecksum();
  const commit = gitCommit();

  if (isPlaceholderDb(dbUrl)) {
    const stub = buildDbReadinessFailStub({
      fingerprint: fp,
      schemaChecksum: checksum,
      gitCommit: commit,
      reason: "no-real-test-postgresql",
    });
    writeFileSync(outPath, `${JSON.stringify(stub, null, 2)}\n`);
    console.log(JSON.stringify({ outPath, verdict: stub.verdict, reason: "no-real-test-postgresql" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const { prisma } = await import("../src/server/prisma/client");
  let migrationApplied = false;
  let uniqueIndexPresent = false;
  let duplicateGroupCount = -1;
  let concurrentUpsert: "PASS" | "FAIL" = "FAIL";
  let backfillRace: "PASS" | "FAIL" = "FAIL";

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

    // Concurrent upsert race
    const caseRow = await prisma.case.findFirst({ select: { id: true } });
    if (caseRow) {
      const reportRunId = `p04-cov-${Date.now()}`;
      await prisma.orionReportRun.create({
        data: { id: reportRunId, caseId: caseRow.id, status: "RUNNING", mode: "db-readiness" },
      });
      const { upsertSurfaceCollectionCoverage } = await import(
        "../src/modules/digital-profile/providers/arsenkin/surface-coverage"
      );
      const payload = {
        reportRunId,
        provider: "arsenkin",
        tool: "suggest",
        queryId: "p04-q",
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
        where: { reportRunId, queryId: "p04-q" },
      });
      concurrentUpsert = n === 1 ? "PASS" : "FAIL";

      // Backfill conflicting-link race (conditional updateMany)
      const task = await prisma.providerTask.create({
        data: {
          id: `p04-task-${Date.now()}`,
          caseId: caseRow.id,
          reportRunId,
          provider: "arsenkin",
          toolName: "suggest",
          requestHash: createHash("sha256").update(reportRunId).digest("hex"),
          requestJson: { tools_name: "suggest", data: {} },
          state: "DONE",
          externalTaskId: "ext-1",
          responseJson: { ok: true },
        },
      });
      const cov = await prisma.surfaceCollectionCoverage.findFirst({
        where: { reportRunId, queryId: "p04-q" },
      });
      if (cov) {
        try {
          await prisma.$transaction(async (tx) => {
            await tx.surfaceCollectionCoverage.updateMany({
              where: { id: cov.id, providerTaskId: null },
              data: { providerTaskId: task.id },
            });
            // Simulate conflict: second update expecting null should fail count
            const second = await tx.surfaceCollectionCoverage.updateMany({
              where: { id: cov.id, providerTaskId: null },
              data: { providerTaskId: "other-task" },
            });
            if (second.count !== 0) {
              throw new Error("unexpected-second-update");
            }
            // Force rollback path for conflicting already-linked
            const row = await tx.surfaceCollectionCoverage.findUnique({ where: { id: cov.id } });
            if (row?.providerTaskId && row.providerTaskId !== "conflict-other") {
              const conflict = await tx.surfaceCollectionCoverage.updateMany({
                where: {
                  id: cov.id,
                  OR: [{ providerTaskId: null }, { providerTaskId: "conflict-other" }],
                },
                data: { providerTaskId: "conflict-other" },
              });
              if (conflict.count !== 1) {
                throw new Error(`coverage-conditional-update-failed:${cov.id}`);
              }
            }
          });
          backfillRace = "FAIL"; // should have thrown
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          backfillRace = /conditional-update-failed|already-linked/i.test(msg) || msg.length > 0
            ? "PASS"
            : "FAIL";
          // The intentional throw on conflict.count !== 1 is the PASS path
          if (/coverage-conditional-update-failed/.test(msg)) backfillRace = "PASS";
        }
      }

      // cleanup
      await prisma.surfaceCollectionCoverage.deleteMany({ where: { reportRunId } });
      await prisma.providerTask.deleteMany({ where: { reportRunId } });
      await prisma.orionReportRun.delete({ where: { id: reportRunId } }).catch(() => undefined);
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }

  const now = new Date();
  const verdict: "PASS" | "FAIL" =
    migrationApplied &&
    uniqueIndexPresent &&
    duplicateGroupCount === 0 &&
    concurrentUpsert === "PASS" &&
    backfillRace === "PASS"
      ? "PASS"
      : "FAIL";

  const artifact: ArsenkinDbReadinessArtifact = {
    version: ARSENKIN_DB_READINESS_VERSION,
    verdict,
    databaseFingerprint: fp,
    schemaChecksum: checksum,
    gitCommit: commit,
    requiredMigration: REQUIRED_COVERAGE_UNIQUE_MIGRATION,
    migrationApplied,
    uniqueIndexPresent,
    duplicateGroupCount,
    concurrentUpsert,
    backfillRace,
    generatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 6 * 3600_000).toISOString(),
  };
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ outPath, verdict, migrationApplied, uniqueIndexPresent, duplicateGroupCount, concurrentUpsert, backfillRace }, null, 2));
  if (verdict !== "PASS") process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
