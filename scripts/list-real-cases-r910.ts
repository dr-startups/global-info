import { prisma } from "../src/server/prisma/client";

const FIXTURE_MARKERS = [
  "ivan petrov",
  "иван петров",
  "example.com",
  "example.ru",
  "video.example.com",
  "qa-r98a-fixture",
];

async function main() {
  const rows = await prisma.case.findMany({
    where: { deletedAt: null, searchResults: { some: {} } },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      subjects: { take: 1, select: { fullName: true } },
      _count: {
        select: { searchResults: true, searchSurfaceItems: true, databaseProfiles: true },
      },
    },
  });

  for (const row of rows) {
    const name = (row.subjects[0]?.fullName ?? "").toLowerCase();
    const isFixture =
      FIXTURE_MARKERS.some((m) => name.includes(m) || row.id.toLowerCase().includes(m)) ||
      row.id === "qa-r98a-fixture-case";
    console.log(
      JSON.stringify({
        id: row.id,
        name: row.subjects[0]?.fullName ?? "",
        title: row.title,
        searchResults: row._count.searchResults,
        surfaces: row._count.searchSurfaceItems,
        dbProfiles: row._count.databaseProfiles,
        isFixture,
        updatedAt: row.updatedAt.toISOString(),
      })
    );
  }
}

main()
  .catch((error) => {
    console.error("DB_ERROR", error instanceof Error ? error.message : String(error));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
