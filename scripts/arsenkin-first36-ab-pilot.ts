/**
 * Arsenkin First36 A/B pilot — fixtures only.
 * Live spend is hard-blocked; use arsenkin-canonical-live-runner.ts.
 *
 *   npm run pilot:arsenkin-first36 -- --fixtures
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { collectArsenkinPilotSurfaces } from "../src/modules/digital-profile/providers/arsenkin";
import { persistSerpObservations } from "../src/modules/digital-profile/serp-observation/persist";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

const CASE_ID = process.argv.find((a) => a.startsWith("--case="))?.slice(7) || "cmreamy2t0002o30f29urzcog";
const WANT_LIVE =
  process.argv.includes("--live") ||
  (process.env.ARSENKIN_ENABLED === "1" &&
    Boolean(process.env.ARSENKIN_API_TOKEN?.trim()) &&
    !process.argv.includes("--fixtures") &&
    process.env.ARSENKIN_PILOT_FIXTURES !== "1");
const PERSIST = process.argv.includes("--persist");

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

async function main() {
  resetArsenkinNetworkCallCount();

  if (WANT_LIVE || process.argv.includes("--live")) {
    const block = {
      entrypoint: "scripts/arsenkin-first36-ab-pilot.ts",
      status: "HARD_FAIL",
      reason: "legacy-live-entrypoint-disabled",
      redirect: "scripts/arsenkin-canonical-live-runner.ts",
      networkCalls: 0,
      tokenPresent: Boolean(String(process.env.ARSENKIN_API_TOKEN ?? "").trim()),
    };
    const dir = join(process.cwd(), "storage", "digital-profile", "qa-first36-canary", "_legacy-blocks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ab-pilot-live-block.json"), `${JSON.stringify(block, null, 2)}\n`);
    console.error(JSON.stringify(block, null, 2));
    process.exit(2);
  }

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
    const baselineRun = topRun ? baseline.filter((b) => b.auditRunId === topRun) : baseline;

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
      fixturesOnly: true,
    });

    if (getArsenkinNetworkCallCount() !== 0) {
      throw new Error("fixtures pilot leaked network calls");
    }

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
      fixturesForced: true,
      networkCalls: getArsenkinNetworkCallCount(),
      baseline: {
        auditRunId: topRun,
        observationCount: baselineRun.length,
        organic: baselineRun.filter((b) => b.surface === "organic").length,
        autocomplete: baselineRun.filter((b) => b.surface === "autocomplete").length,
        providers: [...new Set(baselineRun.map((b) => b.provider))],
      },
      arsenkin: {
        drafts: collected.drafts.length,
        bySurface: collected.bySurface,
        organicDomains: [...new Set(arsenkinOrganic.map((d) => domainOf(d.url)))].slice(0, 20),
        newOrganicVsBaseline: newUrls.length,
        overlapOrganic: overlap.length,
      },
      persisted,
      next: "Use scripts/arsenkin-canonical-live-runner.ts for paid live",
    };
    writeFileSync(join(outRoot, "pilot-report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
