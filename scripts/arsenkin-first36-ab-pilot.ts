/**
 * Arsenkin First36 A/B pilot for Glinka (fixtures by default; live if ARSENKIN_ENABLED+token).
 *
 *   npm run pilot:arsenkin-first36
 *   npm run pilot:arsenkin-first36 -- --fixtures
 *   npm run pilot:arsenkin-first36 -- --persist   # write drafts into a new OrionReportRun
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { collectArsenkinPilotSurfaces } from "../src/modules/digital-profile/providers/arsenkin";
import { persistSerpObservations } from "../src/modules/digital-profile/serp-observation/persist";

const CASE_ID = process.argv.find((a) => a.startsWith("--case="))?.slice(7) || "cmreamy2t0002o30f29urzcog";
const FIXTURES = process.argv.includes("--fixtures") || process.env.ARSENKIN_PILOT_FIXTURES === "1";
const PERSIST = process.argv.includes("--persist");

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function main() {
  const prisma = new PrismaClient();
  const outRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-arsenkin-first36-pilot",
    CASE_ID,
    String(Date.now())
  );
  mkdirSync(outRoot, { recursive: true });

  try {
    const baseline = await prisma.serpObservation.findMany({
      where: { caseId: CASE_ID },
      select: {
        auditRunId: true,
        provider: true,
        engine: true,
        surface: true,
        region: true,
        queryText: true,
        rank: true,
        url: true,
        domain: true,
      },
      take: 5000,
    });

    const byRun = new Map<string, number>();
    for (const b of baseline) byRun.set(b.auditRunId, (byRun.get(b.auditRunId) ?? 0) + 1);
    const topRun = [...byRun.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const baselineRun = topRun
      ? baseline.filter((b) => b.auditRunId === topRun)
      : baseline;

    const subject = await prisma.subject.findFirst({
      where: { caseId: CASE_ID },
      select: { fullName: true },
    });
    const name = subject?.fullName?.trim() || "Глинка Сергей Михайлович";
    const queriesRu = [name, [...name.split(/\s+/)].reverse().join(" ")].filter(Boolean);
    const queriesUae = ["Glinka Sergey Mikhaylovich", "Sergey Glinka"];

    const auditRunId = `arsenkin-pilot-${Date.now()}`;
    if (PERSIST) {
      await prisma.orionReportRun.create({
        data: {
          id: auditRunId,
          caseId: CASE_ID,
          mode: "arsenkin_pilot",
          status: "RUNNING",
          internalOnly: true,
          startedAt: new Date(),
        },
      });
    }

    const collected = await collectArsenkinPilotSurfaces({
      caseId: CASE_ID,
      auditRunId: PERSIST ? auditRunId : `dry-${auditRunId}`,
      queriesRu,
      queriesUae,
      fixturesOnly: FIXTURES || !process.env.ARSENKIN_API_TOKEN?.trim(),
    });

    let persisted = 0;
    if (PERSIST) {
      const rows = await persistSerpObservations(collected.drafts);
      persisted = rows.length;
      await prisma.orionReportRun.update({
        where: { id: auditRunId },
        data: { status: "DONE", finishedAt: new Date() },
      });
    }

    const baselineOrganicUrls = new Set(
      baselineRun.filter((b) => b.surface === "organic").map((b) => b.url)
    );
    const arsenkinOrganic = collected.drafts.filter((d) => d.surface === "organic");
    const newUrls = arsenkinOrganic.filter((d) => !baselineOrganicUrls.has(d.url));
    const overlap = arsenkinOrganic.filter((d) => baselineOrganicUrls.has(d.url));

    const report = {
      caseId: CASE_ID,
      mode: collected.mode,
      fixturesForced: FIXTURES,
      baseline: {
        auditRunId: topRun,
        observationCount: baselineRun.length,
        organic: baselineRun.filter((b) => b.surface === "organic").length,
        autocomplete: baselineRun.filter((b) => b.surface === "autocomplete").length,
        providers: [...new Set(baselineRun.map((b) => b.provider))],
      },
      arsenkin: {
        auditRunId: PERSIST ? auditRunId : null,
        drafts: collected.drafts.length,
        bySurface: collected.bySurface,
        organicDomains: [...new Set(arsenkinOrganic.map((d) => d.domain ?? domainOf(d.url)))].slice(0, 20),
        newOrganicUrls: newUrls.length,
        overlapOrganicUrls: overlap.length,
        sampleSuggest: collected.drafts
          .filter((d) => d.surface === "autocomplete")
          .map((d) => d.title)
          .slice(0, 10),
        samplePaa: collected.drafts
          .filter((d) => d.surface === "paa")
          .map((d) => d.title)
          .slice(0, 10),
      },
      persist: { enabled: PERSIST, persisted },
      pagesImpactHint: ["8-10", "11-12", "20-22", "25-28", "32"],
      nextStep:
        collected.mode === "fixtures"
          ? "Set ARSENKIN_ENABLED=1 and ARSENKIN_API_TOKEN in .env, re-run without --fixtures"
          : "Re-run live First36 render with ORION_FIRST36_RUN_SCOPED=1 against the pilot auditRunId",
    };

    writeFileSync(join(outRoot, "ab-report.json"), JSON.stringify(report, null, 2), "utf-8");
    writeFileSync(
      join(outRoot, "arsenkin-drafts.json"),
      JSON.stringify(collected.drafts, null, 2),
      "utf-8"
    );
    console.log(JSON.stringify({ outRoot, ...report }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
