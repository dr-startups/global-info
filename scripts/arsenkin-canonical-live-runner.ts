/**
 * Canonical Arsenkin live runner — the ONLY paid entrypoint.
 *
 * Modes:
 *   --prepare              create PREPARED fresh run (no network)
 *   (default) plan-only    recompute plan + gates; PLAN_READY|PLAN_BLOCKED (no network)
 *   --execute-live         requires LIVE_CONFIRM + digest + DB readiness PASS artifact
 *
 * Never prints API token.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { spawnSync } from "node:child_process";
import {
  buildArsenkinExecutionPlan,
  type ArsenkinLiveStage,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-execution-plan";
import { buildArsenkinSubjectQueryPlan } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";
import {
  buildPrepareCanaryRunSpec,
  transitionCanaryRun,
  canaryLifecycleOf,
  type CanaryRunRow,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-canary-run-lifecycle";
import { evaluateCanonicalLiveGate } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-canonical-live-gate";
import { authorizationFromPlan } from "../src/modules/digital-profile/providers/arsenkin/execute-arsenkin-execution-plan";
import { collectArsenkinPilotSurfaces } from "../src/modules/digital-profile/providers/arsenkin/collect-pilot-surfaces";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { persistSerpObservations } from "../src/modules/digital-profile/serp-observation/persist";
import {
  fingerprintDatabaseUrl,
  schemaChecksumOf,
  REQUIRED_COVERAGE_UNIQUE_MIGRATION,
  type ArsenkinDbReadinessArtifact,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import { buildPlannedCoverageMatrix } from "../src/modules/digital-profile/providers/arsenkin/planned-coverage-matrix";

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

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function parseStage(raw: string | null): ArsenkinLiveStage {
  const s = (raw ?? "SUGGEST_RU_CANARY").trim();
  if (s === "SUGGEST_RU_CANARY" || s === "FIRST36_STAGE1" || s === "FIRST36_STAGE2") return s;
  throw new Error(`invalid-stage:${s}`);
}

function gitCommitShort(): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" });
  return (r.stdout || "").trim() || "unknown";
}

function currentSchemaChecksum(): string {
  const migDir = join(process.cwd(), "prisma", "migrations");
  const names = existsSync(migDir)
    ? readdirSync(migDir).filter((n) => !n.startsWith("."))
    : [];
  return schemaChecksumOf({
    migrationNames: names.sort(),
    uniqueIndexName: "dp_surface_coverage_biz_unique",
  });
}

async function main() {
  bootstrapEnv();
  resetArsenkinNetworkCallCount();

  const prepare = flag("prepare");
  const executeLive = flag("execute-live");
  const resumeExisting = flag("resume-existing");
  const caseId = arg("case-id");
  const reportRunId = arg("report-run-id");
  const stage = parseStage(arg("stage"));
  const maxNewTasks = Number(arg("max-new-tasks") ?? 0);
  const maxEstimatedLimits = Number(arg("max-estimated-limits") ?? 0);
  const confirmPlanDigest = arg("confirm-plan-digest");
  const liveConfirm = process.env.ARSENKIN_LIVE_CONFIRM === "1";
  const dbReadinessPath =
    arg("db-readiness") ||
    join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p04", "arsenkin-db-readiness.json");
  const urlsEnrichment = (arg("urls-enrichment") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!caseId) throw new Error("--case-id required");
  if (!reportRunId) throw new Error("--report-run-id required");
  if (!(maxNewTasks > 0) || !(maxEstimatedLimits > 0)) {
    throw new Error("--max-new-tasks and --max-estimated-limits are required (>0)");
  }
  if (prepare && executeLive) throw new Error("cannot combine --prepare and --execute-live");

  const outRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
  mkdirSync(outRoot, { recursive: true });

  const { prisma } = await import("../src/server/prisma/client");
  const subject = await prisma.subject.findFirst({
    where: { caseId },
    select: { fullName: true, aliases: true },
  });
  const queryPlan = buildArsenkinSubjectQueryPlan({
    fullName: subject?.fullName,
    aliases: subject?.aliases ?? [],
  });

  const dbUrl = String(process.env.DATABASE_URL ?? "");
  const currentFingerprint = fingerprintDatabaseUrl(dbUrl);
  const currentGitCommit = gitCommitShort();
  const schemaChecksum = currentSchemaChecksum();
  const dbReadiness = readJson<ArsenkinDbReadinessArtifact>(dbReadinessPath);

  if (prepare) {
    const existing = await prisma.orionReportRun.findUnique({ where: { id: reportRunId } });
    const gate = evaluateCanonicalLiveGate({
      mode: "prepare",
      caseId,
      reportRunId,
      stage,
      run: existing as CanaryRunRow | null,
      counts: { providerTaskCount: 0, observationCount: 0, coverageCount: 0 },
      queryPlan,
      executionPlan: null,
      content: null,
      binding: null,
      adminDecisions: null,
      dbReadiness,
      currentDbFingerprint: currentFingerprint,
      currentGitCommit,
      currentSchemaChecksum: schemaChecksum,
      liveConfirm: false,
      confirmPlanDigest: null,
      tokenPresent: false,
      networkCalls: getArsenkinNetworkCallCount(),
    });
    if (!gate.ok) {
      writeJson(join(outRoot, "fresh-run-preflight.json"), { ...gate, networkCalls: 0 });
      console.error(JSON.stringify({ error: "prepare-blocked", ...gate }, null, 2));
      process.exitCode = 1;
      return;
    }
    const spec = buildPrepareCanaryRunSpec({
      reportRunId,
      caseId,
      stage,
      preparedAtIso: new Date().toISOString(),
    });
    await prisma.orionReportRun.create({ data: spec });
    writeJson(join(outRoot, "fresh-run-preflight.json"), {
      verdict: "PREPARED",
      reportRunId,
      caseId,
      networkCalls: getArsenkinNetworkCallCount(),
    });
    console.log(JSON.stringify({ phase: "prepare", status: "PREPARED", reportRunId }, null, 2));
    return;
  }

  const run = (await prisma.orionReportRun.findUnique({
    where: { id: reportRunId },
  })) as CanaryRunRow | null;

  const [providerTaskCount, observationCount, coverageCount] = await Promise.all([
    prisma.providerTask.count({ where: { reportRunId, provider: "arsenkin" } }),
    prisma.serpObservation.count({ where: { auditRunId: reportRunId, provider: "arsenkin" } }),
    prisma.surfaceCollectionCoverage.count({
      where: { reportRunId, provider: "arsenkin" },
    }),
  ]);

  const existingTasks = await prisma.providerTask.findMany({
    where: { reportRunId, provider: "arsenkin" },
    select: { id: true, requestHash: true, state: true },
  });

  const plan = buildArsenkinExecutionPlan({
    caseId,
    reportRunId,
    stage,
    queriesRu: queryPlan.queriesRu,
    queriesUae: queryPlan.queriesUae,
    maxNewTasks,
    maxEstimatedLimits,
    existingTasks,
    urlsEnrichment: stage === "FIRST36_STAGE2" ? urlsEnrichment : [],
  });

  const content = readJson<{ caseId?: string; reportRunId?: string }>(
    join(outRoot, "orion-client-content.post-review.json")
  );
  const binding = readJson<{
    sourceReportRunId?: string;
    effectiveReportRunId?: string;
    overridden?: boolean;
  }>(join(outRoot, "client-content-binding.json"));
  const adminDecisions = readJson<{
    caseId?: string;
    qaSampleOnly?: boolean;
  }>(join(outRoot, "admin-review-decisions.json"));

  const coverageMatrix = buildPlannedCoverageMatrix(plan);
  writeJson(join(outRoot, "arsenkin-live-plan.json"), plan);
  writeJson(join(outRoot, "planned-coverage-matrix.json"), { targets: coverageMatrix });

  const gate = evaluateCanonicalLiveGate({
    mode: executeLive ? "execute-live" : "plan-only",
    caseId,
    reportRunId,
    stage,
    run,
    counts: { providerTaskCount, observationCount, coverageCount },
    resumeExisting,
    queryPlan,
    executionPlan: plan,
    content,
    binding,
    adminDecisions,
    dbReadiness,
    currentDbFingerprint: currentFingerprint,
    currentGitCommit,
    currentSchemaChecksum: schemaChecksum,
    liveConfirm,
    confirmPlanDigest,
    tokenPresent: Boolean(String(process.env.ARSENKIN_API_TOKEN ?? "").trim()),
    networkCalls: getArsenkinNetworkCallCount(),
  });

  writeJson(join(outRoot, "fresh-run-preflight.json"), {
    lifecycle: canaryLifecycleOf(run),
    counts: { providerTaskCount, observationCount, coverageCount },
    gate,
    networkCalls: getArsenkinNetworkCallCount(),
  });
  writeJson(join(outRoot, "client-content-binding-validation.json"), {
    contentPresent: Boolean(content),
    bindingPresent: Boolean(binding),
    adminPresent: Boolean(adminDecisions),
    blockers: gate.blockers.filter((b) => /client|binding|admin|qa-sample/i.test(b)),
  });

  console.log(
    JSON.stringify(
      {
        phase: executeLive ? "execute-preflight" : "plan",
        verdict: gate.verdict,
        digest: plan.digest,
        plannedNewTasks: plan.plannedNewTasks,
        estimatedLimitsTotal: plan.estimatedLimitsTotal,
        requestCount: plan.requests.length,
        networkCalls: getArsenkinNetworkCallCount(),
        blockers: gate.blockers,
      },
      null,
      2
    )
  );

  if (!gate.ok) {
    process.exitCode = 1;
    return;
  }

  if (!executeLive) {
    if (getArsenkinNetworkCallCount() !== 0) throw new Error("plan-only leaked network");
    return;
  }

  // CAS PREPARED → RUNNING before network
  const ownerId = `canary-${process.pid}-${createHash("sha256").update(reportRunId).digest("hex").slice(0, 8)}`;
  const tr = transitionCanaryRun({
    from: "PREPARED",
    to: "RUNNING",
    currentStatus: run?.status ?? null,
    ownerId: null,
    expectedOwnerId: ownerId,
  });
  if (!tr.ok) {
    writeJson(join(outRoot, "execute-transition-blocked.json"), tr);
    process.exitCode = 1;
    return;
  }
  const claimed = await prisma.orionReportRun.updateMany({
    where: { id: reportRunId, caseId, status: "PREPARED" },
    data: {
      status: "RUNNING",
      startedAt: new Date(),
      metadataJson: {
        ...(typeof run?.metadataJson === "object" && run?.metadataJson
          ? (run.metadataJson as object)
          : {}),
        leaseOwnerId: ownerId,
      },
    },
  });
  if (claimed.count !== 1) {
    console.error(JSON.stringify({ error: "cas-claim-failed", reportRunId }, null, 2));
    process.exitCode = 1;
    return;
  }

  const auth = authorizationFromPlan(plan);
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
    await prisma.orionReportRun.update({
      where: { id: reportRunId },
      data: { status: "DONE", finishedAt: new Date() },
    });
    writeJson(join(outRoot, "arsenkin-live-execute-result.json"), {
      mode: collected.mode,
      persisted: persisted.length,
      bySurface: collected.bySurface,
      taskIds: collected.taskIds,
      networkCalls: getArsenkinNetworkCallCount(),
      digest: plan.digest,
      status: "DONE",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.orionReportRun
      .update({
        where: { id: reportRunId },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          errorsJson: { message },
        },
      })
      .catch(() => undefined);
    writeJson(join(outRoot, "arsenkin-live-execute-error.json"), { message, status: "FAILED" });
    console.error(JSON.stringify({ error: message }, null, 2));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
