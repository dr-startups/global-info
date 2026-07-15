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
import { readFileSync } from "node:fs";
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
const surfaceCoverageBusinessKeyFields = [
  "reportRunId",
  "provider",
  "tool",
  "queryId",
  "surface",
  "engine",
  "region",
  "language",
  "device",
] as const;

type CoverageKeyRow = Record<(typeof surfaceCoverageBusinessKeyFields)[number], string>;

function toCoverageBusinessKey(row: CoverageKeyRow): string {
  return surfaceCoverageBusinessKeyFields.map((field) => `${field}=${row[field]}`).join("|");
}

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
      const source = readFileSync(new URL(import.meta.url), "utf8");
      const forbiddenUnsafeRawApi = ["$", "query", "Raw", "Unsafe"].join("");
      assert.equal(
        source.includes(forbiddenUnsafeRawApi),
        false,
        "regression: unsafe raw-query API is forbidden in DB smoke"
      );
      assert.deepEqual(surfaceCoverageBusinessKeyFields, [
        "reportRunId",
        "provider",
        "tool",
        "queryId",
        "surface",
        "engine",
        "region",
        "language",
        "device",
      ]);
      assert.equal(String(process.env.NETWORK_CALLS ?? "0"), "0", "NETWORK_CALLS must be 0 for DB smoke");
      const leakedBeforeRuns = await prisma.orionReportRun.count({
        where: { id: { startsWith: "cov-race-" } },
      });
      const leakedBeforeTasks = await prisma.providerTask.count({
        where: { id: { startsWith: "cov-task-" } },
      });
      const leakedBeforeCoverage = await prisma.surfaceCollectionCoverage.count({
        where: { reportRunId: { startsWith: "cov-race-" } },
      });
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
          where: {
            reportRunId,
            provider: payload.provider,
            tool: payload.tool,
            queryId: payload.queryId,
            surface: payload.surface,
            engine: payload.engine,
            region: payload.region,
            language: payload.language,
            device: payload.device,
          },
          select: {
            id: true,
            reportRunId: true,
            providerTaskId: true,
            provider: true,
            tool: true,
            queryId: true,
            surface: true,
            engine: true,
            region: true,
            language: true,
            device: true,
          },
        });
        assert.equal(rows.length, 1, "exact @@unique business key must yield exactly one row");
        assert.equal(
          new Set(concurrent.map((r) => r.id)).size,
          1,
          "all concurrent results must reference one persisted row id"
        );
        const [row] = rows;
        assert.ok(row);
        assert.equal(row.providerTaskId, providerTaskId);
        assert.equal(row.reportRunId, reportRunId);
        assert.equal(row.id, concurrent[0]?.id, "db row id must match concurrent upsert result id");

        const coverageRows = await prisma.surfaceCollectionCoverage.findMany({
          where: { reportRunId: { startsWith: "cov-race-" } },
          select: {
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
        });
        const grouped = new Map<string, number>();
        for (const coverageRow of coverageRows) {
          const key = toCoverageBusinessKey(coverageRow);
          grouped.set(key, (grouped.get(key) ?? 0) + 1);
        }
        const duplicateGroupCount = [...grouped.values()].filter((count) => count > 1).length;
        assert.equal(duplicateGroupCount, 0);
      } finally {
        // Cleanup order: children -> parent rows.
        await prisma.surfaceCollectionCoverage.deleteMany({ where: { reportRunId } }).catch(() => undefined);
        await prisma.orionArsenkinStageRun.deleteMany({ where: { reportRunId } }).catch(() => undefined);
        await prisma.providerTask.deleteMany({ where: { reportRunId } }).catch(() => undefined);
        await prisma.orionReportRun.delete({ where: { id: reportRunId } }).catch(() => undefined);
        const leakedAfterRuns = await prisma.orionReportRun.count({
          where: { id: { startsWith: "cov-race-" } },
        });
        const leakedAfterTasks = await prisma.providerTask.count({
          where: { id: { startsWith: "cov-task-" } },
        });
        const leakedAfterCoverage = await prisma.surfaceCollectionCoverage.count({
          where: { reportRunId: { startsWith: "cov-race-" } },
        });
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
