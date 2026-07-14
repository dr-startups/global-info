/**
 * Canonical Arsenkin live runner — the ONLY paid entrypoint.
 *
 * Plan-only (default, no network):
 *   npx tsx --env-file=.env scripts/arsenkin-canonical-live-runner.ts \
 *     --case-id=... --report-run-id=... --stage=SUGGEST_RU_CANARY \
 *     --max-new-tasks=2 --max-estimated-limits=2
 *
 * Execute-live (requires all gates; DO NOT run without explicit human approval):
 *   ARSENKIN_LIVE_CONFIRM=1 npx tsx --env-file=.env scripts/arsenkin-canonical-live-runner.ts \
 *     --execute-live --case-id=... --report-run-id=... --stage=SUGGEST_RU_CANARY \
 *     --confirm-plan-digest=<sha256> --max-new-tasks=2 --max-estimated-limits=2
 *
 * Never prints API token.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import {
  buildArsenkinExecutionPlan,
  evaluateExecutionPlanBudget,
  type ArsenkinLiveStage,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-execution-plan";
import { authorizationFromPlan } from "../src/modules/digital-profile/providers/arsenkin/execute-arsenkin-execution-plan";
import { collectArsenkinPilotSurfaces } from "../src/modules/digital-profile/providers/arsenkin/collect-pilot-surfaces";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { persistSerpObservations } from "../src/modules/digital-profile/serp-observation/persist";

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

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function parseStage(raw: string | null): ArsenkinLiveStage {
  const s = (raw ?? "SUGGEST_RU_CANARY").trim();
  if (s === "SUGGEST_RU_CANARY" || s === "FIRST36_STAGE1" || s === "FIRST36_STAGE2") return s;
  throw new Error(`invalid-stage:${s}`);
}

async function loadQueries(caseId: string): Promise<{ queriesRu: string[]; queriesUae: string[] }> {
  const { prisma } = await import("../src/server/prisma/client");
  const subject = await prisma.subject.findFirst({
    where: { caseId },
    select: { fullName: true },
  });
  const name = subject?.fullName?.trim() || "Глинка Сергей Михайлович";
  return {
    queriesRu: [name, [...name.split(/\s+/)].reverse().join(" ")].filter(Boolean),
    queriesUae: ["Glinka Sergey Mikhaylovich", "Sergey Glinka"],
  };
}

async function main() {
  bootstrapEnv();
  resetArsenkinNetworkCallCount();

  const executeLive = flag("execute-live");
  const caseId = arg("case-id") || "cmreamy2t0002o30f29urzcog";
  const reportRunId = arg("report-run-id");
  const stage = parseStage(arg("stage"));
  const maxNewTasks = Number(arg("max-new-tasks") ?? 0);
  const maxEstimatedLimits = Number(arg("max-estimated-limits") ?? 0);
  const confirmPlanDigest = arg("confirm-plan-digest");
  const liveConfirm = process.env.ARSENKIN_LIVE_CONFIRM === "1";
  const urlsEnrichment = (arg("urls-enrichment") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!reportRunId) {
    throw new Error("usage: --report-run-id=<id> required");
  }
  if (!(maxNewTasks > 0) || !(maxEstimatedLimits > 0)) {
    throw new Error("--max-new-tasks and --max-estimated-limits are required (>0)");
  }

  const outRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
  mkdirSync(outRoot, { recursive: true });

  const { queriesRu, queriesUae } = await loadQueries(caseId);
  const { prisma } = await import("../src/server/prisma/client");

  const existingTasks = await prisma.providerTask.findMany({
    where: { reportRunId, provider: "arsenkin" },
    select: { id: true, requestHash: true, state: true },
  });

  // Recompute plan immediately (never trust a user-supplied JSON digest alone).
  const plan = buildArsenkinExecutionPlan({
    caseId,
    reportRunId,
    stage,
    queriesRu,
    queriesUae,
    maxNewTasks,
    maxEstimatedLimits,
    existingTasks,
    urlsEnrichment: stage === "FIRST36_STAGE2" ? urlsEnrichment : [],
  });
  const budget = evaluateExecutionPlanBudget(plan);
  const planPath = join(outRoot, "arsenkin-live-plan.json");
  writeJson(planPath, {
    ...plan,
    // Serialize Set-free plain object (requests already plain)
    networkCallsAtPlan: getArsenkinNetworkCallCount(),
    budget,
  });

  console.log(
    JSON.stringify(
      {
        phase: "plan",
        stage: plan.stage,
        digest: plan.digest,
        plannedNewTasks: plan.plannedNewTasks,
        reuse: plan.requests.filter((r) => r.action === "REUSE").length,
        create: plan.requests.filter((r) => r.action === "CREATE").length,
        estimatedLimitsTotal: plan.estimatedLimitsTotal,
        maxNewTasks: plan.maxNewTasks,
        maxEstimatedLimits: plan.maxEstimatedLimits,
        requestCount: plan.requests.length,
        budgetOk: budget.ok,
        blockers: budget.blockers,
        networkCalls: getArsenkinNetworkCallCount(),
        planPath,
      },
      null,
      2
    )
  );

  if (!executeLive) {
    if (getArsenkinNetworkCallCount() !== 0) {
      throw new Error("plan-only leaked network calls");
    }
    writeJson(join(outRoot, "arsenkin-live-readiness-plan-only.json"), {
      mode: "plan-only",
      NETWORK_CALLS: 0,
      digest: plan.digest,
      verdict: budget.ok ? "PLAN_READY" : "PLAN_BLOCKED",
      blockers: budget.blockers,
    });
    return;
  }

  // --- execute-live gates ---
  const blockers: string[] = [];
  if (!liveConfirm) blockers.push("ARSENKIN_LIVE_CONFIRM!=1");
  if (!confirmPlanDigest) blockers.push("missing --confirm-plan-digest");
  if (confirmPlanDigest && confirmPlanDigest !== plan.digest) {
    blockers.push("confirm-plan-digest-mismatch");
  }
  if (!budget.ok) blockers.push(...budget.blockers);
  if (!String(process.env.ARSENKIN_API_TOKEN ?? "").trim()) {
    blockers.push("ARSENKIN_API_TOKEN missing");
  }

  // Client binding before spend
  const clientContentPath = join(outRoot, "orion-client-content.post-review.json");
  if (!existsSync(clientContentPath)) {
    blockers.push("client-content-missing-before-spend");
  } else {
    const cc = JSON.parse(readFileSync(clientContentPath, "utf-8")) as {
      reportRunId?: string;
      caseId?: string;
      binding?: { sourceReportRunId?: string; effectiveReportRunId?: string; overridden?: boolean };
      adminDecisionSource?: string;
    };
    if (cc.reportRunId !== reportRunId) blockers.push("client-content-reportRunId-mismatch");
    if (cc.caseId !== caseId) blockers.push("client-content-caseId-mismatch");
    const src = cc.binding?.sourceReportRunId ?? cc.reportRunId;
    const eff = cc.binding?.effectiveReportRunId ?? cc.reportRunId;
    if (src !== reportRunId || eff !== reportRunId) blockers.push("foreign-client-content-run");
    if (cc.binding?.overridden === true) blockers.push("client-content-overridden");
    if (/qa.?sample|fixture/i.test(String(cc.adminDecisionSource ?? ""))) {
      blockers.push("qa-sample-decisions-in-client-final");
    }
  }

  if (blockers.length > 0) {
    writeJson(join(outRoot, "arsenkin-live-execute-blocked.json"), { blockers, digest: plan.digest });
    console.error(JSON.stringify({ error: "execute-live-blocked", blockers }, null, 2));
    process.exitCode = 1;
    return;
  }

  const auth = authorizationFromPlan(plan);
  let markFailed = false;
  try {
    const collected = await collectArsenkinPilotSurfaces({
      caseId,
      auditRunId: reportRunId,
      queriesRu: plan.queriesRu,
      queriesUae: plan.queriesUae,
      executionPlan: plan,
      liveAuthorization: auth,
      tools: plan.tools,
      aiSerpTargets: plan.aiSerpTargets,
      urlsEnrichment: plan.urlsEnrichment,
    });
    const persisted = await persistSerpObservations(collected.drafts);
    writeJson(join(outRoot, "arsenkin-live-execute-result.json"), {
      mode: collected.mode,
      persisted: persisted.length,
      bySurface: collected.bySurface,
      taskIds: collected.taskIds,
      networkCalls: getArsenkinNetworkCallCount(),
      digest: plan.digest,
    });
    console.log(
      JSON.stringify(
        {
          phase: "execute-live-done",
          persisted: persisted.length,
          networkCalls: getArsenkinNetworkCallCount(),
        },
        null,
        2
      )
    );
  } catch (err) {
    markFailed = true;
    const message = err instanceof Error ? err.message : String(err);
    writeJson(join(outRoot, "arsenkin-live-execute-error.json"), { message });
    console.error(JSON.stringify({ error: message }, null, 2));
    process.exitCode = 1;
  } finally {
    if (markFailed) {
      await prisma.orionReportRun
        .update({
          where: { id: reportRunId },
          data: {
            status: "FAILED",
            finishedAt: new Date(),
            errorsJson: { reason: "arsenkin-canonical-live-failed" },
          },
        })
        .catch(() => undefined);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
