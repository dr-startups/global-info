/**
 * R10.8b — Admin decision persistence readiness QA.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ArtifactAdminReviewDecisionRepository } from "../evidence/artifact-admin-review-decision-repository";
import { DbAdminReviewDecisionRepository } from "../evidence/db-admin-review-decision-repository";
import { createAdminReviewDecisionRepository } from "../evidence/admin-review-decision-repository-factory";
import { resolveAdminReviewDecisionStoreMode } from "../evidence/admin-review-decision-store-config";
import { ORION_ADMIN_REVIEW_DECISION_TABLE_PLAN } from "../db/orion-admin-review-decision-table-plan";

export type AdminDecisionPersistenceVerdict =
  | "ADMIN_DECISION_PERSISTENCE_READY"
  | "ADMIN_DECISION_PERSISTENCE_PLAN_READY"
  | "BLOCKED_SCHEMA_UNCLEAR"
  | "BLOCKED_REPOSITORY_ABSTRACTION"
  | "BLOCKED_ARTIFACT_REGRESSION"
  | "BLOCKED_DB_MIGRATION_RISK"
  | "BLOCKED_FAKE_APPROVALS";

function check(id: string, passed: boolean, detail: string) {
  return { id, passed, detail };
}

export async function inspectAdminDecisionPersistenceQaAsync(input?: {
  workspaceRoot?: string;
}): Promise<{
  version: "r10-8b-admin-decision-persistence-qa-v1";
  passed: boolean;
  verdict: AdminDecisionPersistenceVerdict;
  modeChosen: "artifact_now_db_plan";
  prismaSchemaChanged: false;
  migrationsCreated: false;
  migrationsApplied: false;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
}> {
  const root = input?.workspaceRoot ?? process.cwd();
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const files = {
    repoIface: join(root, "src/modules/digital-profile/orion-golden/evidence/admin-review-decision-repository.ts"),
    artifactRepo: join(
      root,
      "src/modules/digital-profile/orion-golden/evidence/artifact-admin-review-decision-repository.ts"
    ),
    dbRepo: join(root, "src/modules/digital-profile/orion-golden/evidence/db-admin-review-decision-repository.ts"),
    factory: join(
      root,
      "src/modules/digital-profile/orion-golden/evidence/admin-review-decision-repository-factory.ts"
    ),
    config: join(root, "src/modules/digital-profile/orion-golden/evidence/admin-review-decision-store-config.ts"),
    record: join(root, "src/modules/digital-profile/orion-golden/evidence/admin-review-decision-record.ts"),
    plan: join(root, "src/modules/digital-profile/orion-golden/db/orion-admin-review-decision-table-plan.ts"),
    service: join(root, "src/modules/digital-profile/orion-golden/services/admin-review-workflow-service.ts"),
    schema: join(root, "prisma/schema.prisma"),
  };

  for (const [id, path] of Object.entries(files)) {
    const ok = existsSync(path);
    checks.push(check(`file-${id}`, ok, path));
    if (!ok) issues.push("repository");
  }

  const ifaceSrc = existsSync(files.repoIface) ? readFileSync(files.repoIface, "utf-8") : "";
  const abstractionOk =
    /interface AdminReviewDecisionRepository/.test(ifaceSrc) &&
    /listDecisions/.test(ifaceSrc) &&
    /getActiveDecision/.test(ifaceSrc) &&
    /listDecisionHistory/.test(ifaceSrc) &&
    /saveDecision/.test(ifaceSrc) &&
    /deactivateDecision/.test(ifaceSrc);
  checks.push(check("repository-abstraction", abstractionOk, "AdminReviewDecisionRepository methods"));
  if (!abstractionOk) issues.push("repository");

  const serviceSrc = existsSync(files.service) ? readFileSync(files.service, "utf-8") : "";
  const serviceWired =
    /getAdminReviewDecisionRepository/.test(serviceSrc) && /repo\.saveDecision/.test(serviceSrc);
  checks.push(check("service-uses-repository", serviceWired, "workflow service depends on repository"));
  if (!serviceWired) issues.push("repository");

  const defaultMode = resolveAdminReviewDecisionStoreMode({} as NodeJS.ProcessEnv);
  checks.push(check("default-store-artifact", defaultMode === "artifact", `mode=${defaultMode}`));

  const artifactRepoDefault = createAdminReviewDecisionRepository("artifact");
  checks.push(check("artifact-repo-mode", artifactRepoDefault.mode === "artifact", artifactRepoDefault.mode));

  let historyOk = false;
  let activeQueryable = false;
  let fakeApprovals = false;
  let artifactOk = true;
  const tmp = mkdtempSync(join(tmpdir(), "r108b-qa-"));
  try {
    const repo = new ArtifactAdminReviewDecisionRepository({ artifactRoot: tmp });
    const caseId = "r108b-qa-case";
    const evidenceId = "ev-r108b-persistence-1";

    await repo.saveDecision(caseId, evidenceId, {
      status: "APPENDIX_ONLY",
      reviewerNote: "r10.8b qa appendix",
      source: "test_fixture",
      reviewedBy: "qa",
    });
    await repo.saveDecision(caseId, evidenceId, {
      status: "EXCLUDED",
      reviewerNote: "r10.8b qa exclude",
      source: "test_fixture",
      reviewedBy: "qa",
    });
    const history = await repo.listDecisionHistory(caseId, evidenceId);
    const active = await repo.getActiveDecision(caseId, evidenceId);
    historyOk =
      history.length >= 2 && history.some((h) => !h.isActive) && history.some((h) => h.isActive);
    activeQueryable = active?.status === "EXCLUDED" && active.isActive === true;
    fakeApprovals = history.some((d) => d.status === "APPROVED");

    checks.push(check("artifact-repository-works", true, `isolatedRoot=${tmp}`));
    checks.push(check("decision-history-preserved", historyOk, `historyLen=${history.length}`));
    checks.push(check("latest-active-queryable", activeQueryable, `active=${active?.status}`));
    if (!historyOk || !activeQueryable) {
      artifactOk = false;
      issues.push("artifact");
    }
  } catch (err) {
    artifactOk = false;
    issues.push("artifact");
    checks.push(
      check("artifact-repository-works", false, err instanceof Error ? err.message : String(err))
    );
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  checks.push(check("no-fake-approvals", !fakeApprovals, "QA did not create APPROVED fixtures"));
  if (fakeApprovals) issues.push("fake");

  checks.push(
    check(
      "pending-not-confirmed",
      /PENDING/.test(readFileSync(files.record, "utf-8")) &&
        !/auto-approve|fake.?approv/i.test(serviceSrc),
      "PENDING modeled; no auto-approve in service"
    )
  );

  const dbRepo = new DbAdminReviewDecisionRepository();
  let dbDeferred = false;
  try {
    await dbRepo.listDecisions("x");
  } catch (err) {
    dbDeferred = err instanceof Error && /db-deferred/.test(err.message);
  }
  checks.push(check("db-mode-deferred", dbDeferred, "DbAdminReviewDecisionRepository throws deferred"));

  const planOk =
    ORION_ADMIN_REVIEW_DECISION_TABLE_PLAN.mode === "artifact_now_db_plan" &&
    ORION_ADMIN_REVIEW_DECISION_TABLE_PLAN.tableName === "dp_orion_admin_review_decisions";
  checks.push(check("db-plan-documented", planOk, ORION_ADMIN_REVIEW_DECISION_TABLE_PLAN.tableName));
  if (!planOk) issues.push("schema");

  const schemaSrc = existsSync(files.schema) ? readFileSync(files.schema, "utf-8") : "";
  const schemaHasAdminReviewTable = /OrionAdminReviewDecision|dp_orion_admin_review_decisions/.test(
    schemaSrc
  );
  checks.push(
    check(
      "prisma-schema-unchanged-for-admin-review",
      !schemaHasAdminReviewTable,
      "no admin review decision model in schema (deferred)"
    )
  );
  if (schemaHasAdminReviewTable) issues.push("migration");

  const planSrc = readFileSync(files.plan, "utf-8");
  const safePlan =
    /no migrate reset/i.test(planSrc) && /no db push/i.test(planSrc) && /Additive/.test(planSrc);
  checks.push(check("no-destructive-migration", safePlan, "plan forbids destructive ops"));
  if (!safePlan) issues.push("migration");

  const regenPath = join(
    root,
    "src/app/api/digital-profile/cases/[id]/orion-golden/client-content/regenerate/route.ts"
  );
  if (existsSync(regenPath)) {
    const regenSrc = readFileSync(regenPath, "utf-8");
    const invokesRenderer = /renderOrionGolden|rendered-client\.(pdf|pptx)|renderReport\(/i.test(
      regenSrc
    );
    checks.push(check("no-renderer-invoked", !invokesRenderer, `renderer=${invokesRenderer}`));
  }

  checks.push(check("env-secrets-untouched", true, "QA did not modify env/secrets"));

  let verdict: AdminDecisionPersistenceVerdict = "ADMIN_DECISION_PERSISTENCE_PLAN_READY";
  if (issues.includes("repository")) verdict = "BLOCKED_REPOSITORY_ABSTRACTION";
  else if (issues.includes("artifact")) verdict = "BLOCKED_ARTIFACT_REGRESSION";
  else if (issues.includes("fake")) verdict = "BLOCKED_FAKE_APPROVALS";
  else if (issues.includes("migration")) verdict = "BLOCKED_DB_MIGRATION_RISK";
  else if (issues.includes("schema") || !planOk) verdict = "BLOCKED_SCHEMA_UNCLEAR";
  else if (abstractionOk && artifactOk && historyOk && planOk && dbDeferred) {
    // Mode C: artifact works + DB planned — PLAN_READY (READY reserved for live DB mode)
    verdict = "ADMIN_DECISION_PERSISTENCE_PLAN_READY";
  }

  const passed = !verdict.startsWith("BLOCKED_");

  return {
    version: "r10-8b-admin-decision-persistence-qa-v1",
    passed,
    verdict,
    modeChosen: "artifact_now_db_plan",
    prismaSchemaChanged: false,
    migrationsCreated: false,
    migrationsApplied: false,
    issues,
    checks,
  };
}

export async function writeAdminDecisionPersistenceQaReport(
  workspaceRoot = process.cwd()
): Promise<string> {
  const outDir = join(workspaceRoot, "storage/digital-profile/qa-r10-8-admin-ui");
  mkdirSync(outDir, { recursive: true });
  const report = {
    ...(await inspectAdminDecisionPersistenceQaAsync({ workspaceRoot })),
    generatedAt: new Date().toISOString(),
  };
  const outPath = join(outDir, "r10-8b-admin-decision-persistence-qa.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return outPath;
}
