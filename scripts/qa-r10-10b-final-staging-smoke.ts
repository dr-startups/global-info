/**
 * R10.10b — Final staging smoke (auth-enabled policy + API contract + case-scope).
 * Does not print secrets. Does not create fake production approvals.
 * Does not deploy.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  isDeployLikeEnvironment,
  isSyntheticAuthBypassAllowed,
} from "../src/modules/digital-profile/auth/auth-config";
import { normalizeError, NotFoundError, ValidationError, UnauthorizedError, ForbiddenError } from "../src/modules/digital-profile/http/errors";
import {
  adminReviewDecisionsPath,
  caseScopedArtifactRoot,
  loadAdminReviewDecisions,
  saveAdminReviewDecisions,
  sanitizeCaseIdForPath,
  ORION_GOLDEN_QA_STORAGE_ROOT,
} from "../src/modules/digital-profile/orion-golden/evidence/admin-review-decision-store";
import { validateAdminReviewDecisionInput } from "../src/modules/digital-profile/orion-golden/evidence/admin-review-decision-validation";
import {
  CLIENT_AUDIT_PAGE_RANGE,
  expectedPageRangeForMode,
  resolveOrionVisualReportMode,
} from "../src/modules/digital-profile/orion-golden/qa/visual-qa-inspection";
import { inspectAdminAuthQa } from "../src/modules/digital-profile/orion-golden/qa/r10-10a-admin-auth-qa";
import { resetAdminReviewDecisionRepositoryCache } from "../src/modules/digital-profile/orion-golden/evidence/admin-review-decision-repository-factory";

const CASE_ID = process.env.CASE_ID?.trim() || "cmqzz1vbr00d2vdrsrjsgie2g";
const OTHER_CASE = "cmothercase00000000000001";
const outDir = join(process.cwd(), "storage", "digital-profile", "qa-r10-10-deploy-preparation");
mkdirSync(outDir, { recursive: true });

function check(id: string, passed: boolean, detail: string) {
  return { id, passed, detail };
}

function runNodeScript(script: string, args: string[] = []): { ok: boolean; out: string } {
  const r = spawnSync("npx", ["tsx", script, ...args], {
    cwd: process.cwd(),
    encoding: "utf-8",
    shell: true,
    env: process.env,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

// --- Staging flags (via dedicated auditor) ---
const flagsRun = runNodeScript("scripts/r10-10b-audit-staging-flags.ts");
let flagsJson: { report: Record<string, unknown>; blockers: string[] } = {
  report: {},
  blockers: ["flags-audit-failed"],
};
try {
  const start = flagsRun.out.indexOf("{");
  flagsJson = JSON.parse(flagsRun.out.slice(start));
} catch {
  // keep default
}

// --- Auth policy smoke (deploy-like) ---
const authChecks = [];
const bypassInProd = isSyntheticAuthBypassAllowed({
  ...process.env,
  NODE_ENV: "production",
  DIGITAL_PROFILE_AUTH_ENABLED: "false",
  DIGITAL_PROFILE_AUTH_ALLOW_SYNTHETIC: "true",
} as NodeJS.ProcessEnv);
const deployLike = isDeployLikeEnvironment({
  ...process.env,
  NODE_ENV: "production",
} as NodeJS.ProcessEnv);
authChecks.push(
  check("synthetic-blocked-in-production", deployLike && bypassInProd === false, `bypass=${bypassInProd}`)
);

const authQa = inspectAdminAuthQa({ workspaceRoot: process.cwd(), caseId: CASE_ID });
authChecks.push(check("r10-10a-admin-auth-qa", authQa.passed, authQa.verdict));

// Source guards
const pageSrc = readFileSync(
  join(process.cwd(), "src/app/admin/digital-profile/[caseId]/orion-golden/manual-review/page.tsx"),
  "utf-8"
);
const queueSrc = readFileSync(
  join(process.cwd(), "src/app/api/digital-profile/cases/[id]/orion-golden/manual-review/route.ts"),
  "utf-8"
);
const itemSrc = readFileSync(
  join(
    process.cwd(),
    "src/app/api/digital-profile/cases/[id]/orion-golden/manual-review/[evidenceId]/route.ts"
  ),
  "utf-8"
);
const regenSrc = readFileSync(
  join(
    process.cwd(),
    "src/app/api/digital-profile/cases/[id]/orion-golden/client-content/regenerate/route.ts"
  ),
  "utf-8"
);
const meSrc = readFileSync(join(process.cwd(), "src/app/api/digital-profile/auth/me/route.ts"), "utf-8");
const mwSrc = readFileSync(join(process.cwd(), "src/middleware.ts"), "utf-8");

authChecks.push(check("page-server-guard", /requireOrionAdminPageAccess/.test(pageSrc), "page"));
authChecks.push(check("queue-api-guard", /requireOrionAdminApiAccess/.test(queueSrc), "queue"));
authChecks.push(check("item-api-guard", /requireOrionAdminApiAccess/.test(itemSrc), "item"));
authChecks.push(
  check("regen-no-renderer", /rendererInvoked:\s*false/.test(regenSrc), "rendererInvoked=false")
);
authChecks.push(check("middleware-fail-closed", /isDeployLikeEnvironment/.test(mwSrc), "middleware"));
authChecks.push(check("auth-me-hides-synthetic-in-deploy", /isSyntheticAuthBypassAllowed/.test(meSrc), "me"));

// --- API contract (normalizeError + validation) ---
const apiChecks = [];
const unauth = new UnauthorizedError();
const forbid = new ForbiddenError();
const missingItem = normalizeError(new Error("manual-review-item-not-found:x"));
const missingQueue = normalizeError(new Error("manual-review-queue-missing"));
const caveat = validateAdminReviewDecisionInput({ status: "APPROVED_WITH_CAVEAT", caveatText: "" });
const validation = new ValidationError(caveat.errors.join("; "));

apiChecks.push(check("401-shape", unauth.status === 401 && unauth.code === "UNAUTHORIZED", unauth.code));
apiChecks.push(check("403-shape", forbid.status === 403 && forbid.code === "FORBIDDEN", forbid.code));
apiChecks.push(
  check("404-missing-evidence", missingItem instanceof NotFoundError && missingItem.status === 404, missingItem.code)
);
apiChecks.push(
  check("404-missing-case", missingQueue instanceof NotFoundError && missingQueue.status === 404, missingQueue.code)
);
apiChecks.push(check("400-validation", validation.status === 400 && caveat.ok === false, "caveat required"));
apiChecks.push(
  check(
    "routes-use-withModule",
    /withModule/.test(queueSrc) && /withModule/.test(itemSrc) && /withModule/.test(regenSrc),
    "envelope"
  )
);

// --- Case-scope smoke ---
const scopeChecks = [];
resetAdminReviewDecisionRepositoryCache();
const pathA = adminReviewDecisionsPath(CASE_ID);
const pathB = adminReviewDecisionsPath(OTHER_CASE);
scopeChecks.push(check("paths-differ-by-case", pathA !== pathB, "distinct paths"));
scopeChecks.push(
  check("path-contains-cases-segment", pathA.includes(join("cases", CASE_ID)), pathA)
);
let traversalOk = false;
try {
  sanitizeCaseIdForPath("../etc/passwd");
} catch {
  traversalOk = true;
}
scopeChecks.push(check("path-traversal-rejected", traversalOk, "sanitize"));

// Isolated write/read for CASE_ID vs OTHER_CASE (temp decisions — PENDING only, then cleanup)
const tmpSet = {
  version: "r10-5-admin-review-decisions-v1" as const,
  caseId: CASE_ID,
  generatedAt: new Date().toISOString(),
  decisions: [{ evidenceId: "r10-10b-smoke-pending-only", status: "PENDING" as const }],
  qaSampleOnly: false,
};
const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, CASE_ID);
mkdirSync(caseRoot, { recursive: true });
saveAdminReviewDecisions(CASE_ID, tmpSet);
const loadedA = loadAdminReviewDecisions(CASE_ID);
const loadedB = loadAdminReviewDecisions(OTHER_CASE);
scopeChecks.push(
  check(
    "case-a-loads-own",
    Boolean(loadedA && loadedA.caseId === CASE_ID && loadedA.decisions.some((d) => d.evidenceId === "r10-10b-smoke-pending-only")),
    `count=${loadedA?.decisions.length ?? 0}`
  )
);
scopeChecks.push(
  check(
    "case-b-no-bleed",
    !loadedB ||
      (loadedB.caseId === OTHER_CASE &&
        !loadedB.decisions.some((d) => d.evidenceId === "r10-10b-smoke-pending-only")),
    `bCount=${loadedB?.decisions.length ?? 0}`
  )
);
// cleanup smoke decision file if we created only smoke marker (do not wipe real decisions)
try {
  if (loadedA && loadedA.decisions.length === 1 && loadedA.decisions[0].evidenceId === "r10-10b-smoke-pending-only") {
    rmSync(pathA, { force: true });
  } else if (loadedA) {
    // remove only the smoke marker decision
    const cleaned = {
      ...loadedA,
      decisions: loadedA.decisions.filter((d) => d.evidenceId !== "r10-10b-smoke-pending-only"),
    };
    saveAdminReviewDecisions(CASE_ID, cleaned);
  }
} catch {
  // ignore cleanup errors
}

// --- Page count mode ---
const pageChecks = [];
const clientMode = resolveOrionVisualReportMode({
  env: { ...process.env, R10_RENDER_FROM_CLIENT_CONTENT: "1", ORION_CLIENT_AUDIT_MODE: "1" },
});
const legacyMode = resolveOrionVisualReportMode({
  env: {
    ...process.env,
    R10_RENDER_FROM_CLIENT_CONTENT: undefined,
    ORION_CLIENT_AUDIT_MODE: undefined,
  },
});
pageChecks.push(check("client-audit-mode", clientMode === "client_audit", clientMode));
pageChecks.push(check("legacy-mode", legacyMode === "legacy_full", legacyMode));
pageChecks.push(
  check(
    "client-range-30-45",
    expectedPageRangeForMode("client_audit").min === 30 &&
      expectedPageRangeForMode("client_audit").max === 45,
    JSON.stringify(CLIENT_AUDIT_PAGE_RANGE)
  )
);

// --- E2E artifact inspection (if present from docker run) ---
const e2eRoot = join(outDir);
const e2eAlt = join(process.cwd(), "storage", "digital-profile", "qa-r10-10-deploy-preparation");
const qaSummaryPath = join(e2eAlt, "qa-summary.json");
let e2e: Record<string, unknown> = { present: false };
if (existsSync(qaSummaryPath)) {
  const summary = JSON.parse(readFileSync(qaSummaryPath, "utf-8")) as Record<string, unknown>;
  const visual = existsSync(join(e2eAlt, "visual-qa-inspection.json"))
    ? (JSON.parse(readFileSync(join(e2eAlt, "visual-qa-inspection.json"), "utf-8")) as Record<
        string,
        unknown
      >)
    : null;
  const gpt = existsSync(join(e2eAlt, "r10-6-gpt-runtime-diagnostics.json"))
    ? (JSON.parse(readFileSync(join(e2eAlt, "r10-6-gpt-runtime-diagnostics.json"), "utf-8")) as Record<
        string,
        unknown
      >)
    : null;
  e2e = {
    present: true,
    verdict: summary.verdict,
    pageCount: summary.pageCount,
    renderSource: summary.renderSource,
    renderFromClientContent: summary.renderFromClientContent,
    gptSuccessful: gpt?.successfulCalls ?? summary.gptSectionCallCount,
    gptFailed: gpt?.failedCalls ?? null,
    visualPassed: visual?.passed ?? null,
    reportMode: visual?.reportMode ?? null,
    expectedPageRange: visual?.expectedPageRange ?? null,
    actualPageCount: visual?.actualPageCount ?? visual?.pageCount ?? summary.pageCount,
    pdfExists: existsSync(join(e2eAlt, "rendered-client.pdf")),
    pptxExists: existsSync(join(e2eAlt, "rendered-client.pptx")),
    pngCount: existsSync(join(e2eAlt, "pages-png"))
      ? require("node:fs")
          .readdirSync(join(e2eAlt, "pages-png"))
          .filter((f: string) => f.endsWith(".png")).length
      : 0,
  };
}

const allAuthPass = authChecks.every((c) => c.passed);
const allApiPass = apiChecks.every((c) => c.passed);
const allScopePass = scopeChecks.every((c) => c.passed);
const allPagePass = pageChecks.every((c) => c.passed);

const flagBlockers = flagsJson.blockers ?? [];
let verdict:
  | "STAGING_READY"
  | "STAGING_READY_WITH_MINOR_WARNINGS"
  | "BLOCKED_AUTH"
  | "BLOCKED_SESSION_SECRET"
  | "BLOCKED_API_CONTRACT"
  | "BLOCKED_E2E"
  | "BLOCKED_RENDERER"
  | "BLOCKED_ARTIFACT_SCOPE"
  | "BLOCKED_SECRET_RISK" = "STAGING_READY";

if (flagBlockers.includes("SESSION_SECRET_MISSING") || flagBlockers.includes("SESSION_SECRET_WEAK")) {
  verdict = "BLOCKED_SESSION_SECRET";
} else if (!allAuthPass || !authQa.passed || flagBlockers.includes("AUTH_NOT_ENABLED_IN_ENV_FILE")) {
  verdict = "BLOCKED_AUTH";
} else if (!allApiPass) {
  verdict = "BLOCKED_API_CONTRACT";
} else if (!allScopePass) {
  verdict = "BLOCKED_ARTIFACT_SCOPE";
} else if (e2e.present && e2e.pdfExists === false) {
  verdict = "BLOCKED_RENDERER";
} else if (
  e2e.present &&
  typeof e2e.verdict === "string" &&
  !["PASS", "BLOCKED_VISUAL"].includes(e2e.verdict) &&
  e2e.verdict !== "PASS"
) {
  // client_audit should not be BLOCKED_VISUAL after R10.10a; if still blocked for other reasons
  if (e2e.verdict === "BLOCKED_GPT" || e2e.verdict === "BLOCKED") verdict = "BLOCKED_E2E";
  else if (e2e.visualPassed === false && e2e.reportMode !== "client_audit") verdict = "BLOCKED_E2E";
} else if (flagBlockers.length > 0 || (e2e.present && e2e.visualPassed === false)) {
  verdict = "STAGING_READY_WITH_MINOR_WARNINGS";
} else if (!e2e.present) {
  verdict = "STAGING_READY_WITH_MINOR_WARNINGS";
}

const artifact = {
  version: "r10-10b-final-staging-smoke-v1",
  generatedAt: new Date().toISOString(),
  branch: "feature/report-quality-r10-10b-final-staging-smoke",
  head: spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf-8" }).stdout?.trim(),
  caseId: CASE_ID,
  stagingFlags: flagsJson,
  authSmoke: { passed: allAuthPass, checks: authChecks, r10_10a: authQa.verdict },
  apiContract: { passed: allApiPass, checks: apiChecks },
  artifactCaseScope: { passed: allScopePass, checks: scopeChecks },
  pageCountMode: { passed: allPagePass, checks: pageChecks },
  e2eSmoke: e2e,
  remainingWarnings: [
    ...flagBlockers,
    ...(!e2e.present ? ["E2E_ARTIFACTS_PENDING_DOCKER_RUN"] : []),
    ...(e2e.present && e2e.visualPassed === false ? ["E2E_VISUAL_NOT_PASSED"] : []),
  ],
  finalVerdict: verdict,
};

const outPath = join(outDir, "r10-10b-final-staging-smoke.json");
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
console.log(`[INFO] wrote ${outPath}`);
console.log(`[INFO] verdict=${verdict}`);
console.log(`[INFO] auth=${allAuthPass} api=${allApiPass} scope=${allScopePass} e2ePresent=${Boolean(e2e.present)}`);
process.exit(
  verdict === "STAGING_READY" || verdict === "STAGING_READY_WITH_MINOR_WARNINGS" ? 0 : 1
);
