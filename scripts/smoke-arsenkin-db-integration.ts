/**
 * DB integration smoke for Arsenkin SurfaceCollectionCoverage concurrent upsert.
 *
 *   npm run smoke:arsenkin-db-integration
 *
 * Local without DB → SKIP (exit 0) unless ARSENKIN_DB_INTEGRATION_REQUIRED=1 → FAIL.
 * Never uses production apply/backfill; never calls live Arsenkin API.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import {
  buildDbIntegrationOrionReportRun,
  buildDbIntegrationProviderTask,
} from "../src/modules/digital-profile/providers/arsenkin/db-integration-fixtures";

function dbUrlPresent(): boolean {
  const url = String(process.env.DATABASE_URL ?? "").trim();
  if (!url) return false;
  // Reject the placeholder used by offline typecheck shells.
  if (/postgresql:\/\/u:p@127\.0\.0\.1:5432\/db/i.test(url)) return false;
  if (/postgresql:\/\/user:pass@localhost/i.test(url)) return false;
  return true;
}

const required = process.env.ARSENKIN_DB_INTEGRATION_REQUIRED === "1";
const hasDb = dbUrlPresent();

describe("arsenkin DB integration", () => {
  it("reports honest SKIP when DATABASE_URL unavailable (local profile)", { skip: hasDb || required }, () => {
    assert.ok(!hasDb);
    console.log("SKIP arsenkin-db-integration: DATABASE_URL not configured for real test Postgres");
  });

  it("fails when DB integration is required but DATABASE_URL missing", { skip: hasDb || !required }, () => {
    assert.fail("ARSENKIN_DB_INTEGRATION_REQUIRED=1 but DATABASE_URL is missing/placeholder");
  });

  it(
    "concurrent upsert of one business key yields exactly one row",
    { skip: !hasDb },
    async () => {
      const { prisma } = await import("../src/server/prisma/client");
      const leakedBefore = await prisma.$queryRawUnsafe<
        Array<{ report_runs: bigint | number; provider_tasks: bigint | number; coverage_rows: bigint | number }>
      >(
        `select
           (select count(*) from dp_orion_report_runs where id like 'cov-race-%') as report_runs,
           (select count(*) from dp_provider_tasks where id like 'cov-task-%') as provider_tasks,
           (select count(*) from dp_surface_collection_coverage where report_run_id like 'cov-race-%') as coverage_rows`
      );
      const leakedBeforeRuns = Number(leakedBefore[0]?.report_runs ?? 0);
      const leakedBeforeTasks = Number(leakedBefore[0]?.provider_tasks ?? 0);
      const leakedBeforeCoverage = Number(leakedBefore[0]?.coverage_rows ?? 0);
      assert.equal(
        leakedBeforeRuns + leakedBeforeTasks + leakedBeforeCoverage,
        0,
        `stale test rows detected before run: runs=${leakedBeforeRuns}, tasks=${leakedBeforeTasks}, coverage=${leakedBeforeCoverage}`
      );

      const { upsertSurfaceCollectionCoverage } = await import(
        "../src/modules/digital-profile/providers/arsenkin/surface-coverage"
      );

      // Prefer an existing case id; this smoke only creates/deletes isolated run-scoped rows.
      const caseRow = await prisma.case.findFirst({ select: { id: true } });
      if (!caseRow) {
        await prisma.$disconnect().catch(() => undefined);
        if (required) assert.fail("no Case for DB integration");
        console.log("SKIP: no Case rows in test DB");
        return;
      }

      const reportRunId = `cov-race-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const providerTaskId = `cov-task-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const requestHash = `cov-race-${reportRunId}`;

      await prisma.orionReportRun.create({
        data: buildDbIntegrationOrionReportRun({ reportRunId, caseId: caseRow.id }),
      });
      await prisma.providerTask.create({
        data: buildDbIntegrationProviderTask({
          providerTaskId,
          reportRunId,
          requestHash,
        }),
      });

      const payload = {
        reportRunId,
        provider: "arsenkin",
        tool: "suggest",
        providerTaskId,
        queryId: "q1",
        queryText: "test",
        engine: "GOOGLE",
        region: "RU",
        language: "ru",
        device: "DESKTOP",
        surface: "autocomplete",
        resultCount: 0,
      };

      try {
        const concurrent = await Promise.all([
          upsertSurfaceCollectionCoverage(payload),
          upsertSurfaceCollectionCoverage({ ...payload, resultCount: 1 }),
          upsertSurfaceCollectionCoverage({ ...payload, resultCount: 2 }),
          upsertSurfaceCollectionCoverage({ ...payload, resultCount: 3 }),
        ]);
        const returnedIds = new Set(concurrent.map((r) => r.id));
        assert.equal(returnedIds.size, 1, "all concurrent upserts must resolve to the same row id");

        const rows = await prisma.surfaceCollectionCoverage.findMany({
          where: { reportRunId, tool: "suggest", queryId: "q1" },
        });
        assert.equal(rows.length, 1);
        const [row] = rows;
        assert.ok(row);
        assert.equal(row.providerTaskId, providerTaskId);
        assert.equal(row.reportRunId, reportRunId);

        const duplicateGroups = await prisma.$queryRawUnsafe<Array<{ cnt: bigint | number }>>(
          `select count(*) as cnt from (
             select report_run_id, provider, tool, query_id, surface, engine, region, language, device, count(*) c
             from dp_surface_collection_coverage
             where report_run_id = $1
             group by report_run_id, provider, tool, query_id, surface, engine, region, language, device
             having count(*) > 1
           ) t`,
          reportRunId
        );
        const duplicateGroupCount = Number(duplicateGroups[0]?.cnt ?? 0);
        assert.equal(duplicateGroupCount, 0);
      } finally {
        // Cleanup order: children -> parent rows.
        await prisma.surfaceCollectionCoverage.deleteMany({ where: { reportRunId } }).catch(() => undefined);
        await prisma.orionArsenkinStageRun.deleteMany({ where: { reportRunId } }).catch(() => undefined);
        await prisma.providerTask.deleteMany({ where: { reportRunId } }).catch(() => undefined);
        await prisma.orionReportRun.delete({ where: { id: reportRunId } }).catch(() => undefined);
        const leakedAfter = await prisma.$queryRawUnsafe<
          Array<{ report_runs: bigint | number; provider_tasks: bigint | number; coverage_rows: bigint | number }>
        >(
          `select
             (select count(*) from dp_orion_report_runs where id like 'cov-race-%') as report_runs,
             (select count(*) from dp_provider_tasks where id like 'cov-task-%') as provider_tasks,
             (select count(*) from dp_surface_collection_coverage where report_run_id like 'cov-race-%') as coverage_rows`
        );
        const leakedAfterRuns = Number(leakedAfter[0]?.report_runs ?? 0);
        const leakedAfterTasks = Number(leakedAfter[0]?.provider_tasks ?? 0);
        const leakedAfterCoverage = Number(leakedAfter[0]?.coverage_rows ?? 0);
        assert.equal(
          leakedAfterRuns + leakedAfterTasks + leakedAfterCoverage,
          0,
          `cleanupOk=false; stale rows remain: runs=${leakedAfterRuns}, tasks=${leakedAfterTasks}, coverage=${leakedAfterCoverage}`
        );
        await prisma.$disconnect().catch(() => undefined);
      }
    }
  );
});
