/**
 * DB integration smoke for Arsenkin SurfaceCollectionCoverage concurrent upsert.
 *
 *   npm run smoke:arsenkin-db-integration
 *
 * Local without DB → SKIP (exit 0) unless ARSENKIN_DB_INTEGRATION_REQUIRED=1 → FAIL.
 * Never uses production apply/backfill; never calls live Arsenkin API.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
      const { upsertSurfaceCollectionCoverage } = await import(
        "../src/modules/digital-profile/providers/arsenkin/surface-coverage"
      );

      // Prefer an existing case id; create ephemeral report run.
      const caseRow = await prisma.case.findFirst({ select: { id: true } });
      if (!caseRow) {
        await prisma.$disconnect().catch(() => undefined);
        if (required) assert.fail("no Case for DB integration");
        console.log("SKIP: no Case rows in test DB");
        return;
      }

      const reportRunId = `cov-race-${Date.now()}`;
      await prisma.orionReportRun.create({
        data: {
          id: reportRunId,
          caseId: caseRow.id,
          status: "RUNNING",
        },
      });

      const payload = {
        reportRunId,
        provider: "arsenkin",
        tool: "suggest",
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
        await Promise.all([
          upsertSurfaceCollectionCoverage(payload),
          upsertSurfaceCollectionCoverage({ ...payload, resultCount: 1 }),
          upsertSurfaceCollectionCoverage({ ...payload, resultCount: 2 }),
          upsertSurfaceCollectionCoverage({ ...payload, resultCount: 3 }),
        ]);
        const rows = await prisma.surfaceCollectionCoverage.findMany({
          where: { reportRunId, tool: "suggest", queryId: "q1" },
        });
        assert.equal(rows.length, 1);
      } finally {
        await prisma.surfaceCollectionCoverage.deleteMany({ where: { reportRunId } }).catch(() => undefined);
        await prisma.orionReportRun.delete({ where: { id: reportRunId } }).catch(() => undefined);
        await prisma.$disconnect().catch(() => undefined);
      }
    }
  );
});
