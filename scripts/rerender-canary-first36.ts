/**
 * Re-render an existing canary reportRunId without accidental paid submits.
 *
 *   npx tsx scripts/rerender-canary-first36.ts <reportRunId> [caseId] --rerender-only
 *   npx tsx scripts/rerender-canary-first36.ts <reportRunId> [--tools=...] --allow-new-provider-tasks
 *     # also requires ARSENKIN_LIVE_CONFIRM=1
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { prisma } from "../src/server/prisma/client";
import { runOrionClassicAuditRender } from "../src/modules/digital-profile/orion-golden/classic/run-orion-classic-audit-render";
import {
  buildPlannedTaskPreflight,
  formatRerenderNetworkSummary,
} from "../src/modules/digital-profile/orion-golden/classic/rerender-task-preflight";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

function bootstrapEnv(tools: string, rerenderOnly: boolean): void {
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
  process.env.ARSENKIN_TOOLS = tools;
  if (rerenderOnly) {
    process.env.ARSENKIN_RERENDER_ONLY = "1";
    process.env.ARSENKIN_ENRICH_ON_RENDER = "1"; // enrich path short-circuits without network
  } else {
    delete process.env.ARSENKIN_RERENDER_ONLY;
    process.env.ARSENKIN_ENRICH_ON_RENDER = "1";
  }
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
  const toolsFlag = process.argv.find((a) => a.startsWith("--tools="))?.slice("--tools=".length);
  const rerenderOnly =
    process.argv.includes("--rerender-only") ||
    (!toolsFlag && !process.argv.includes("--allow-new-provider-tasks") && !process.argv.includes("--allow-new-tasks"));
  const allowNewProviderTasks =
    process.argv.includes("--allow-new-provider-tasks") || process.argv.includes("--allow-new-tasks");
  const liveConfirm = process.env.ARSENKIN_LIVE_CONFIRM === "1";

  if (!reportRunId) {
    throw new Error(
      "usage: rerender-canary-first36.ts <reportRunId> [caseId] [--rerender-only] [--tools=...] [--allow-new-provider-tasks]"
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
  resetArsenkinNetworkCallCount();

  const tasksBefore = await prisma.providerTask.findMany({
    where: { reportRunId, provider: "arsenkin" },
    select: {
      toolName: true,
      requestHash: true,
      state: true,
      requestJson: true,
      limitsSpent: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const preflight = buildPlannedTaskPreflight({
    reportRunId,
    tasks: tasksBefore,
    requestedTools: toolsFlag ? toolsFlag.split(",").map((t) => t.trim()).filter(Boolean) : null,
    rerenderOnly,
    allowNewProviderTasks,
    liveConfirm,
  });
  writeJson(join(outputRoot, "planned-task-preflight.json"), {
    ...preflight,
    taskCountBefore: tasksBefore.length,
    networkCallsBefore: getArsenkinNetworkCallCount(),
  });
  console.log(JSON.stringify({ phase: "planned-task-preflight", ...preflight }, null, 2));

  if (preflight.blocked || (preflight.plannedNewTasks > 0 && rerenderOnly)) {
    const summary = formatRerenderNetworkSummary({
      reused: preflight.reusedTasks,
      wouldCreate: preflight.wouldCreate,
      created: 0,
      networkCalls: getArsenkinNetworkCallCount(),
    });
    console.error(
      JSON.stringify(
        {
          error: "rerender_blocked",
          reason: preflight.blockReason ?? "plannedNewTasks>0",
          plannedNewTasks: preflight.plannedNewTasks,
          summary,
        },
        null,
        2
      )
    );
    process.exitCode = 1;
    return;
  }

  bootstrapEnv(preflight.tools.join(","), rerenderOnly);

  const before = {
    observations: await prisma.serpObservation.count({
      where: { auditRunId: reportRunId, provider: "arsenkin" },
    }),
    tasks: tasksBefore.length,
  };

  const result = await runOrionClassicAuditRender({
    caseId,
    outputRoot,
    reportRunIdOverride: reportRunId,
  });

  const tasksAfter = await prisma.providerTask.count({
    where: { reportRunId, provider: "arsenkin" },
  });
  const created = Math.max(0, tasksAfter - before.tasks);
  const networkCalls = getArsenkinNetworkCallCount();
  const summary = formatRerenderNetworkSummary({
    reused: preflight.reusedTasks,
    wouldCreate: preflight.wouldCreate,
    created,
    networkCalls,
  });

  if (rerenderOnly && (created > 0 || networkCalls > 0 || tasksAfter !== before.tasks)) {
    writeJson(join(outputRoot, "rerender-only-violation.json"), {
      taskCountBefore: before.tasks,
      taskCountAfter: tasksAfter,
      created,
      networkCalls,
      summary,
    });
    throw new Error(`rerender-only violated: ${summary}`);
  }

  writeJson(join(outputRoot, "rerender-summary.json"), {
    reportRunId,
    tools: preflight.tools,
    rerenderOnly,
    before,
    after: {
      observationCount: await prisma.serpObservation.count({
        where: { auditRunId: reportRunId, provider: "arsenkin" },
      }),
      taskCount: tasksAfter,
    },
    plannedNewTasks: preflight.plannedNewTasks,
    REUSED: preflight.reusedTasks,
    WOULD_CREATE: preflight.wouldCreate,
    CREATED: created,
    NETWORK_CALLS: networkCalls,
    summary,
    renderQaReady: result.renderQaReady,
    readiness: result.readiness,
    ceoReady: result.ceoReady,
    verdict: result.verdict,
    acceptance: result.acceptance,
    blockers: result.acceptance?.issues ?? result.warnings.slice(0, 20),
  });

  console.log(summary);
  console.log(
    JSON.stringify(
      {
        ...result,
        tools: preflight.tools,
        plannedNewTasks: preflight.plannedNewTasks,
        REUSED: preflight.reusedTasks,
        WOULD_CREATE: preflight.wouldCreate,
        CREATED: created,
        NETWORK_CALLS: networkCalls,
        summary,
      },
      null,
      2
    )
  );
  if (result.readiness === "CEO_READY" && !result.ceoReady) process.exitCode = 1;
  if (!result.acceptance?.passed) process.exitCode = 1;
  if (result.verdict !== "PASS") process.exitCode = 1;
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(1);
});
