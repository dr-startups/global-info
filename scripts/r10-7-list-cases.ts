/**
 * R10.7 — List available cases with evidence counts (read-only).
 */
import { prisma } from "../src/server/prisma/client";

async function main() {
  const cases = await prisma.case.findMany({
    where: { deletedAt: null },
    orderBy: { updatedAt: "desc" },
    take: 30,
    select: {
      id: true,
      title: true,
      status: true,
      updatedAt: true,
      targetRegions: true,
      subjects: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { fullName: true },
      },
      _count: {
        select: {
          searchResults: true,
          searchSurfaceItems: true,
          databaseProfiles: true,
          riskFindings: true,
        },
      },
    },
  });

  for (const c of cases) {
    const sr = c._count.searchResults;
    const ss = c._count.searchSurfaceItems;
    const db = c._count.databaseProfiles;
    const rf = c._count.riskFindings;
    const total = sr + ss + db + rf;
    const regions = Array.isArray(c.targetRegions) ? (c.targetRegions as string[]).join(",") : "";
    console.log(
      JSON.stringify({
        id: c.id,
        title: c.title,
        subjectName: c.subjects[0]?.fullName ?? null,
        status: c.status,
        regions,
        searchResults: sr,
        searchSurfaces: ss,
        databaseProfiles: db,
        riskFindings: rf,
        total,
        updatedAt: c.updatedAt.toISOString(),
      })
    );
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
