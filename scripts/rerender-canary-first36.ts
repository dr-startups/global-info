/**
 * Re-render an existing canary reportRunId; optionally expand ARSENKIN_TOOLS for stage-2 enrich.
 *
 *   npx tsx scripts/rerender-canary-first36.ts <reportRunId> [caseId] [--tools=check-top,suggest,paa,ai-serp,check-h,indexation]
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { prisma } from "../src/server/prisma/client";
import { runOrionClassicAuditRender } from "../src/modules/digital-profile/orion-golden/classic/run-orion-classic-audit-render";

function bootstrapEnv(tools: string): void {
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const parsed = parse(readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
  }
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
  process.env.ARSENKIN_TOOLS = tools;
}

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function main() {
  const reportRunId = process.argv[2]?.trim();
  const caseIdArg = process.argv[3]?.trim();
  const caseId =
    caseIdArg && !caseIdArg.startsWith("--")
      ? caseIdArg
      : "cmreamy2t0002o30f29urzcog";
  const toolsArg =
    process.argv.find((a) => a.startsWith("--tools="))?.slice("--tools=".length) ||
    "check-top,suggest,paa,ai-serp,check-h,indexation";
  if (!reportRunId) {
    throw new Error(
      "usage: rerender-canary-first36.ts <reportRunId> [caseId] [--tools=...]"
    );
  }
  bootstrapEnv(toolsArg);

  const outputRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
  mkdirSync(outputRoot, { recursive: true });

  const before = {
    observations: await prisma.serpObservation.count({
      where: { auditRunId: reportRunId, provider: "arsenkin" },
    }),
    tasks: await prisma.providerTask.count({
      where: { reportRunId, provider: "arsenkin" },
    }),
    bySurface: await prisma.serpObservation.groupBy({
      by: ["surface"],
      where: { auditRunId: reportRunId, provider: "arsenkin" },
      _count: true,
    }),
  };
  writeJson(join(outputRoot, "stage2-preflight.json"), {
    reportRunId,
    tools: toolsArg,
    before,
  });
  console.log(
    JSON.stringify({ phase: "stage2-preflight", reportRunId, tools: toolsArg, before }, null, 2)
  );

  const result = await runOrionClassicAuditRender({
    caseId,
    outputRoot,
    reportRunIdOverride: reportRunId,
  });

  const tasks = await prisma.providerTask.findMany({
    where: { reportRunId, provider: "arsenkin" },
    orderBy: { createdAt: "asc" },
  });
  const observations = await prisma.serpObservation.groupBy({
    by: ["region", "engine", "surface"],
    where: { auditRunId: reportRunId, provider: "arsenkin" },
    _count: true,
  });
  writeJson(join(outputRoot, "stage2-summary.json"), {
    reportRunId,
    tools: toolsArg,
    before,
    after: {
      observationCount: await prisma.serpObservation.count({
        where: { auditRunId: reportRunId, provider: "arsenkin" },
      }),
      taskCount: tasks.length,
      bySurface: observations,
      newTasks: tasks
        .filter((t) => ["ai-serp", "check-h", "indexation"].includes(t.toolName))
        .map((t) => ({
          tool: t.toolName,
          taskId: t.externalTaskId,
          state: t.state,
          latencyMs: t.latencyMs,
          limitsSpent: t.limitsSpent,
        })),
    },
    readiness: result.readiness,
    ceoReady: result.ceoReady,
    verdict: result.verdict,
    warnings: result.warnings.slice(0, 20),
  });

  console.log(JSON.stringify({ ...result, stage2Tools: toolsArg }, null, 2));
  if (result.verdict !== "PASS" || !result.ceoReady) process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
