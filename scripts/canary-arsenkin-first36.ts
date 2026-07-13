/**
 * Phase 6 clean live canary: new reportRunId, first batch check-top/suggest/paa only.
 *
 *   npx tsx scripts/canary-arsenkin-first36.ts [caseId]
 *
 * Never prints API token.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { prisma } from "../src/server/prisma/client";
import { runOrionClassicAuditRender } from "../src/modules/digital-profile/orion-golden/classic/run-orion-classic-audit-render";

function bootstrapEnv(): void {
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const parsed = parse(readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
  }
  process.env.DATABASE_URL ??=
    "postgresql://postgres:postgres@localhost:5432/global_info?schema=public";
  process.env.ORION_CLASSIC_AUDIT_MODE = "1";
  process.env.ORION_FIRST36_CEO_MODE = "1";
  process.env.ORION_FIRST36_RUN_SCOPED = "1";
  process.env.ORION_FIRST36_LEGACY_CASEWIDE_FALLBACK = "0";
  process.env.ORION_GOLDEN_FORCE_LOCAL_RENDER = "1";
  process.env.ORION_CLASSIC_CLIENT_FINALIZE = "1";
  process.env.ARSENKIN_ENABLED = "1";
  process.env.ARSENKIN_PILOT_FIXTURES = "0";
  process.env.ARSENKIN_REQUIRED = "1";
  process.env.ARSENKIN_ENRICH_ON_RENDER = "1";
  // First batch only
  process.env.ARSENKIN_TOOLS = "check-top,suggest,paa";
}

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

const caseId =
  process.argv[2]?.trim() ||
  process.env.CASE_ID?.trim() ||
  "cmreamy2t0002o30f29urzcog";

const baselineRunId =
  process.argv.find((a) => a.startsWith("--baseline="))?.slice("--baseline=".length) ||
  process.env.ARSENKIN_BASELINE_RUN_ID ||
  "orion-r10-1783721072833";

async function main() {
  bootstrapEnv();
  if (!String(process.env.ARSENKIN_API_TOKEN ?? "").trim()) {
    console.error(
      JSON.stringify({
        ok: false,
        reason: "LIVE CANARY NOT RUN: ARSENKIN_API_TOKEN missing",
      })
    );
    process.exit(2);
  }

  const reportRunId = `orion-canary-${Date.now()}`;
  await prisma.orionReportRun.create({
    data: {
      id: reportRunId,
      caseId,
      mode: "classic_first36_canary",
      status: "RUNNING",
      internalOnly: true,
      startedAt: new Date(),
      metadataJson: {
        canary: true,
        tools: process.env.ARSENKIN_TOOLS,
        baselineRunId,
      },
    },
  });

  const preObs = await prisma.serpObservation.count({
    where: { auditRunId: reportRunId, provider: "arsenkin" },
  });
  const preTasks = await prisma.providerTask.count({
    where: { reportRunId, provider: "arsenkin" },
  });
  if (preObs !== 0 || preTasks !== 0) {
    throw new Error(
      `Clean canary precondition failed: obs=${preObs} tasks=${preTasks} for ${reportRunId}`
    );
  }

  const outputRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
  mkdirSync(outputRoot, { recursive: true });
  writeJson(join(outputRoot, "canary-preflight.json"), {
    caseId,
    reportRunId,
    baselineRunId,
    arsenkinObservations: preObs,
    providerTaskLinks: preTasks,
    tools: process.env.ARSENKIN_TOOLS,
    ARSENKIN_REQUIRED: process.env.ARSENKIN_REQUIRED,
    ARSENKIN_PILOT_FIXTURES: process.env.ARSENKIN_PILOT_FIXTURES,
    tokenPresent: Boolean(process.env.ARSENKIN_API_TOKEN),
  });

  console.log(
    JSON.stringify(
      {
        phase: "preflight",
        caseId,
        reportRunId,
        baselineRunId,
        arsenkinObservations: preObs,
        providerTaskLinks: preTasks,
        tools: process.env.ARSENKIN_TOOLS,
      },
      null,
      2
    )
  );

  let result: Awaited<ReturnType<typeof runOrionClassicAuditRender>>;
  try {
    result = await runOrionClassicAuditRender({
      caseId,
      outputRoot,
      reportRunIdOverride: reportRunId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeJson(join(outputRoot, "canary-error.json"), { message });
    await prisma.orionReportRun.update({
      where: { id: reportRunId },
      data: { status: "FAILED", finishedAt: new Date(), errorsJson: { message } },
    });
    console.error(JSON.stringify({ ok: false, reportRunId, error: message }, null, 2));
    process.exit(1);
  }

  const tasks = await prisma.providerTask.findMany({
    where: { reportRunId, provider: "arsenkin" },
    orderBy: { createdAt: "asc" },
  });
  const observations = await prisma.serpObservation.findMany({
    where: { auditRunId: reportRunId, provider: "arsenkin" },
    select: {
      id: true,
      surface: true,
      engine: true,
      region: true,
      providerStatus: true,
      queryText: true,
      url: true,
      rank: true,
      providerTaskId: true,
    },
  });
  const coverage = await prisma.surfaceCollectionCoverage.findMany({
    where: { reportRunId, provider: "arsenkin" },
  });

  const bySurface = observations.reduce<Record<string, number>>((acc, o) => {
    const k = `${o.region}|${o.engine}|${o.surface}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});

  const baselineObs = await prisma.serpObservation.findMany({
    where: { auditRunId: baselineRunId, provider: "arsenkin", surface: "organic" },
    select: { url: true, domain: true, rank: true },
    take: 200,
  });
  const canaryOrganic = observations.filter((o) => o.surface === "organic");
  const baselineUrls = new Set(baselineObs.map((o) => o.url));
  const canaryUrls = new Set(canaryOrganic.map((o) => o.url));
  const overlap = [...canaryUrls].filter((u) => baselineUrls.has(u)).slice(0, 20);
  const uniqueNew = [...canaryUrls].filter((u) => !baselineUrls.has(u)).slice(0, 20);

  writeJson(join(outputRoot, "observations-summary.json"), {
    reportRunId,
    count: observations.length,
    bySurface,
    sample: observations.slice(0, 30),
  });
  writeJson(join(outputRoot, "ab-report.json"), {
    baselineRunId,
    canaryRunId: reportRunId,
    top20Overlap: overlap,
    uniqueNewRelevantUrls: uniqueNew,
    suggestionsPaaCoverage: {
      ruSuggest: observations.filter((o) => o.surface === "autocomplete" && o.region === "RU").length,
      uaeSuggest: observations.filter((o) => o.surface === "autocomplete" && /UAE|AE/i.test(o.region))
        .length,
      ruPaa: observations.filter((o) => o.surface === "paa" && o.region === "RU").length,
      uaePaa: observations.filter((o) => o.surface === "paa" && /UAE|AE/i.test(o.region)).length,
    },
    taskLatency: tasks.map((t) => ({
      tool: t.toolName,
      taskId: t.externalTaskId,
      state: t.state,
      latencyMs: t.latencyMs,
      limitsSpent: t.limitsSpent,
      limitsBefore: t.limitsBefore,
      limitsAfter: t.limitsAfter,
    })),
    limitsSpentTotal: tasks.reduce((s, t) => s + (t.limitsSpent ?? 0), 0),
    providerErrors: tasks.filter((t) => t.state === "FAILED" || t.state === "SUBMIT_UNKNOWN"),
    noResults: observations.filter((o) => o.providerStatus === "NO_RESULTS").length,
    pageContributionNote:
      "Suggest→p11/p12/p28; PAA→p20-22/p32; organic→SERP/tables via run-scoped merge",
  });

  // Ensure required artifact copies exist with expected names
  if (!existsSync(join(outputRoot, "provider-tasks.json"))) {
    writeJson(join(outputRoot, "provider-tasks.json"), tasks);
  }
  if (!existsSync(join(outputRoot, "surface-coverage.json"))) {
    writeJson(join(outputRoot, "surface-coverage.json"), { reportRunId, rows: coverage });
  }

  const pagesDir = join(outputRoot, "pages-png");
  const pngCount = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => /\.png$/i.test(f)).length
    : 0;

  await prisma.orionReportRun.update({
    where: { id: reportRunId },
    data: {
      status: result.verdict === "PASS" ? "DONE" : "FAILED",
      finishedAt: new Date(),
      metadataJson: {
        canary: true,
        readiness: result.readiness,
        ceoReady: result.ceoReady,
        observationCount: observations.length,
        taskCount: tasks.length,
      },
    },
  });

  const summary = {
    ok: result.verdict === "PASS",
    caseId,
    reportRunId,
    baselineRunId,
    preflight: { arsenkinObservations: 0, providerTaskLinks: 0 },
    observationCount: observations.length,
    bySurface,
    tasks: tasks.map((t) => ({
      tool: t.toolName,
      taskId: t.externalTaskId,
      state: t.state,
      latencyMs: t.latencyMs,
      limitsSpent: t.limitsSpent,
    })),
    coverageRows: coverage.length,
    outputRoot,
    pngCount,
    pdf: existsSync(join(outputRoot, "rendered-client.pdf")),
    pptx: existsSync(join(outputRoot, "rendered-client.pptx")),
    readiness: result.readiness,
    ceoReady: result.ceoReady,
    verdict: result.verdict,
    warnings: result.warnings.slice(0, 20),
  };
  writeJson(join(outputRoot, "canary-summary.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok || !summary.ceoReady) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
