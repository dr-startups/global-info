/**
 * R10.7 — Inspect case evidence quality (domains, mock vs real).
 */
import { prisma } from "../src/server/prisma/client";

const caseId = process.argv[2] ?? "cmr5oqxo301bqvdag2yf0v6sj";

async function main() {
  const caseRow = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: {
      id: true,
      title: true,
      targetRegions: true,
      subjects: { take: 1, select: { fullName: true, aliases: true } },
    },
  });
  if (!caseRow) throw new Error("case-not-found");

  const [searchResults, searchSurfaceItems, databaseProfiles, riskFindings] = await Promise.all([
    prisma.searchResult.findMany({
      where: { caseId },
      select: { id: true, url: true, title: true, snippet: true, engine: true, source: true },
      take: 200,
    }),
    prisma.searchSurfaceItem.findMany({
      where: { caseId, deletedAt: null },
      select: { id: true, url: true, domain: true, title: true, region: true, type: true },
      take: 200,
    }),
    prisma.databaseProfile.findMany({
      where: { caseId },
      select: { id: true, provider: true, matchedName: true, summary: true },
    }),
    prisma.riskFinding.findMany({
      where: { caseId },
      select: { id: true, title: true, category: true, severity: true },
      take: 50,
    }),
  ]);

  const domains = new Map<string, number>();
  const addDomain = (url: string | null | undefined) => {
    if (!url) return;
    const d = url.replace(/^https?:\/\//i, "").split("/")[0]?.replace(/^www\./i, "").toLowerCase() ?? "";
    if (d) domains.set(d, (domains.get(d) ?? 0) + 1);
  };
  for (const r of searchResults) addDomain(r.url);
  for (const s of searchSurfaceItems) addDomain(s.domain ?? s.url);

  const sortedDomains = [...domains.entries()].sort((a, b) => b[1] - a[1]);
  const mockDomains = sortedDomains.filter(([d]) => d.includes("example") || d.includes("localhost"));
  const realDomains = sortedDomains.filter(([d]) => !d.includes("example") && !d.includes("localhost"));

  console.log(
    JSON.stringify(
      {
        caseId: caseRow.id,
        title: caseRow.title,
        subjectName: caseRow.subjects[0]?.fullName ?? null,
        aliases: caseRow.subjects[0]?.aliases ?? [],
        targetRegions: caseRow.targetRegions,
        counts: {
          searchResults: searchResults.length,
          searchSurfaceItems: searchSurfaceItems.length,
          databaseProfiles: databaseProfiles.length,
          riskFindings: riskFindings.length,
        },
        topDomains: sortedDomains.slice(0, 15),
        mockDomainCount: mockDomains.reduce((s, [, n]) => s + n, 0),
        realDomainCount: realDomains.reduce((s, [, n]) => s + n, 0),
        databaseProviders: databaseProfiles.map((p) => p.provider),
        sampleTitles: searchResults.slice(0, 5).map((r) => ({ title: r.title, url: r.url, engine: r.engine })),
        sampleDbProfiles: databaseProfiles.slice(0, 3).map((p) => ({
          provider: p.provider,
          matchedName: p.matchedName,
          summary: (p.summary ?? "").slice(0, 120),
        })),
      },
      null,
      2
    )
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
