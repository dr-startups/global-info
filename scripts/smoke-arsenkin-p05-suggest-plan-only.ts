/**
 * Fresh SUGGEST_RU_CANARY plan-only on test DB (no live). NETWORK_CALLS must stay 0.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ARSENKIN_DB_READINESS_VERSION,
  computeSchemaContentHash,
  computeSourceTreeHash,
  fingerprintDatabaseUrl,
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import {
  createProductionCanonicalStageDeps,
  executeCanonicalArsenkinStage,
} from "../src/modules/digital-profile/orion-golden/classic/execute-canonical-arsenkin-stage";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

async function main() {
  resetArsenkinNetworkCallCount();
  const dbUrl = String(process.env.DATABASE_URL ?? "");
  if (!dbUrl) throw new Error("DATABASE_URL required");
  const { prisma } = await import("../src/server/prisma/client");

  const caseId = `p05-canary-case-${randomUUID().slice(0, 8)}`;
  const reportRunId = `p05-canary-run-${randomUUID().slice(0, 8)}`;
  const outRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
  mkdirSync(outRoot, { recursive: true });
  const readinessPath = join(outRoot, "arsenkin-db-readiness.json");
  const buildCommit = "p05-plan-only-test-build";

  const readiness: ArsenkinDbReadinessArtifact = {
    version: ARSENKIN_DB_READINESS_VERSION,
    verdict: "PASS",
    databaseFingerprint: fingerprintDatabaseUrl(dbUrl),
    buildCommit,
    buildId: "plan-only",
    dirtyTree: false,
    sourceTreeHash: computeSourceTreeHash(),
    schemaContentHash: computeSchemaContentHash(),
    requiredMigration: "20260714180000_surface_coverage_biz_unique",
    migrationApplied: true,
    uniqueIndexPresent: true,
    duplicateGroupCount: 0,
    concurrentUpsert: "PASS",
    backfillRace: "PASS",
    environment: "test",
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    cleanupAttempted: true,
    cleanupOk: true,
  };
  writeJsonAtomic(readinessPath, readiness);
  writeJsonAtomic(join(outRoot, "orion-client-content.post-review.json"), { caseId, reportRunId });
  writeJsonAtomic(join(outRoot, "client-content-binding.json"), {
    sourceReportRunId: reportRunId,
    effectiveReportRunId: reportRunId,
    overridden: false,
  });
  writeJsonAtomic(join(outRoot, "admin-review-decisions.json"), {
    caseId,
    qaSampleOnly: false,
  });

  await prisma.case.create({
    data: {
      id: caseId,
      caseNumber: `P05-CANARY-${Date.now()}`,
      title: "P0.5 suggest canary plan-only",
      createdBy: "p05-plan-only",
    },
  });
  await prisma.subject.create({
    data: { caseId, fullName: "Сидоров Сидор Сидорович", aliases: [] },
  });

  const deps = createProductionCanonicalStageDeps(prisma, {
    getNetworkCalls: getArsenkinNetworkCallCount,
    databaseUrl: dbUrl,
  });
  deps.resolveBuild = () => ({
    buildCommit,
    buildId: "plan-only",
    dirtyTree: false,
    source: "env",
  });

  const prep = await executeCanonicalArsenkinStage(deps, {
    mode: "prepare",
    caseId,
    reportRunId,
    stage: "SUGGEST_RU_CANARY",
    workflow: "suggest-canary",
    maxNewTasks: 2,
    maxEstimatedLimits: 2,
    dbReadinessPath: readinessPath,
    outRoot,
  });
  if (!prep.ok) throw new Error(`prepare failed: ${prep.blockers?.join(",")}`);

  const plan = await executeCanonicalArsenkinStage(deps, {
    mode: "plan-only",
    caseId,
    reportRunId,
    stage: "SUGGEST_RU_CANARY",
    workflow: "suggest-canary",
    maxNewTasks: 2,
    maxEstimatedLimits: 2,
    dbReadinessPath: readinessPath,
    outRoot,
    tokenPresent: true,
  });

  const dossier = {
    version: "arsenkin-p05-suggest-plan-only-v1",
    verdict: plan.verdict,
    ok: plan.ok,
    reportRunId,
    caseId,
    digest: plan.digest,
    plannedNewTasks: plan.plannedNewTasks,
    estimatedLimitsTotal: plan.estimatedLimitsTotal,
    requestCount: plan.requestCount,
    networkCalls: getArsenkinNetworkCallCount(),
    liveExecuted: false,
    outRoot,
  };
  writeJsonAtomic(
    join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p05", "arsenkin-p05-suggest-plan-only.json"),
    dossier
  );
  console.log(JSON.stringify(dossier, null, 2));

  // cleanup
  await prisma.orionArsenkinStageRun.deleteMany({ where: { reportRunId } });
  await prisma.orionReportRun.delete({ where: { id: reportRunId } });
  await prisma.subject.deleteMany({ where: { caseId } });
  await prisma.case.delete({ where: { id: caseId } });
  await prisma.$disconnect();
  if (getArsenkinNetworkCallCount() !== 0) process.exitCode = 1;
  if (!plan.ok || plan.plannedNewTasks !== 2) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
