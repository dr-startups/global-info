const { PrismaClient } = require("@prisma/client");
const fs = require("fs");
const caseId = process.argv[2];
if (!caseId) {
  console.error("usage: export-case-context.cjs <caseId> <outPath>");
  process.exit(1);
}
const outPath = process.argv[3];
const prisma = new PrismaClient();
async function main() {
  const caseRow = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    include: {
      subjects: { take: 1 },
      searchResults: true,
      searchSurfaceItems: { where: { deletedAt: null } },
      databaseProfiles: true,
      riskFindings: true,
      wikipediaChecks: true,
      reportVersions: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!caseRow) throw new Error("case-not-found");
  fs.writeFileSync(outPath, JSON.stringify({ caseId, exportedAt: new Date().toISOString(), caseRow }, null, 2));
  console.log(JSON.stringify({ ok: true, outPath, searchResults: caseRow.searchResults.length }));
}
main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
