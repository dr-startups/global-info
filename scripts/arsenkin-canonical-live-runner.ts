/**
 * Canonical Arsenkin live runner CLI — thin adapter over executeCanonicalArsenkinStage.
 * ONLY paid entrypoint. Never prints API token or full DATABASE_URL.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import type { ArsenkinLiveStage } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-execution-plan";
import {
  createProductionCanonicalStageDeps,
  executeCanonicalArsenkinStage,
  parseWorkflow,
  workflowForStage,
} from "../src/modules/digital-profile/orion-golden/classic/execute-canonical-arsenkin-stage";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

function bootstrapEnv(): void {
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const parsed = parse(readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
  }
}

function arg(name: string): string | null {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length).trim() : null;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function parseStage(raw: string | null): ArsenkinLiveStage {
  const s = (raw ?? "SUGGEST_RU_CANARY").trim();
  if (s === "SUGGEST_RU_CANARY" || s === "FIRST36_STAGE1" || s === "FIRST36_STAGE2") return s;
  throw new Error(`invalid-stage:${s}`);
}

async function main() {
  bootstrapEnv();
  resetArsenkinNetworkCallCount();

  const prepare = flag("prepare");
  const executeLive = flag("execute-live");
  if (prepare && executeLive) throw new Error("cannot combine --prepare and --execute-live");

  const caseId = arg("case-id");
  const reportRunId = arg("report-run-id");
  const stage = parseStage(arg("stage"));
  const workflow = arg("workflow") ? parseWorkflow(arg("workflow")) : workflowForStage(stage);
  const maxNewTasks = Number(arg("max-new-tasks") ?? 0);
  const maxEstimatedLimits = Number(arg("max-estimated-limits") ?? 0);
  const confirmPlanDigest = arg("confirm-plan-digest");
  const liveConfirm = process.env.ARSENKIN_LIVE_CONFIRM === "1";
  const dbReadinessPath =
    arg("db-readiness") ||
    join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p05", "arsenkin-db-readiness.json");

  if (!caseId) throw new Error("--case-id required");
  if (!reportRunId) throw new Error("--report-run-id required");

  const { prisma } = await import("../src/server/prisma/client");
  const deps = createProductionCanonicalStageDeps(prisma, {
    getNetworkCalls: getArsenkinNetworkCallCount,
  });

  const result = await executeCanonicalArsenkinStage(deps, {
    mode: prepare ? "prepare" : executeLive ? "execute-live" : "plan-only",
    caseId,
    reportRunId,
    stage,
    workflow,
    maxNewTasks,
    maxEstimatedLimits,
    confirmPlanDigest,
    liveConfirm,
    dbReadinessPath,
    tokenPresent: Boolean(String(process.env.ARSENKIN_API_TOKEN ?? "").trim()),
    resumeExisting: flag("resume-existing"),
  });

  console.log(
    JSON.stringify(
      {
        phase: result.phase,
        verdict: result.verdict,
        digest: result.digest,
        stage: result.stage,
        workflow: result.workflow,
        plannedNewTasks: result.plannedNewTasks,
        estimatedLimitsTotal: result.estimatedLimitsTotal,
        requestCount: result.requestCount,
        networkCalls: result.networkCalls,
        collectorCalls: result.collectorCalls,
        runStatus: result.runStatus,
        runAggregate: result.runAggregate,
        blockers: result.blockers,
      },
      null,
      2
    )
  );

  process.exitCode = result.exitCode;
  await prisma.$disconnect().catch(() => undefined);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
