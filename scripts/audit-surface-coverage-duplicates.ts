/**
 * Read-only audit of SurfaceCollectionCoverage duplicate business-key groups.
 *
 *   npx tsx --env-file=.env scripts/audit-surface-coverage-duplicates.ts
 *
 * Never deletes or mutates rows. Prints groups + counts for migration preflight.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "../src/server/prisma/client";
import {
  findSurfaceCoverageDuplicateGroups,
  type SurfaceCoverageDupRow,
} from "../src/modules/digital-profile/providers/arsenkin/surface-coverage-duplicate-audit";

async function main() {
  const rows = (await prisma.surfaceCollectionCoverage.findMany({
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
      providerTaskId: true,
      resultCount: true,
      status: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  })) as SurfaceCoverageDupRow[];

  const audit = findSurfaceCoverageDuplicateGroups(rows);
  const outDir = join(process.cwd(), "storage", "digital-profile", "qa-first36-canary", "coverage-dup-audit");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `coverage-duplicates-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(outPath, `${JSON.stringify({ ...audit, outPath }, null, 2)}\n`, "utf-8");
  console.log(
    JSON.stringify(
      {
        totalRows: audit.totalRows,
        duplicateGroupCount: audit.duplicateGroupCount,
        duplicateRowCount: audit.duplicateRowCount,
        groups: audit.groups.slice(0, 50),
        outPath,
        note: "read-only; no deletes performed",
      },
      null,
      2
    )
  );
  if (audit.duplicateGroupCount > 0) process.exitCode = 2;
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
