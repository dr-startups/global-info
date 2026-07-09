/**
 * R10.10a — Write production-readiness-after-auth artifact.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { inspectAdminAuthQa } from "../src/modules/digital-profile/orion-golden/qa/r10-10a-admin-auth-qa";
import {
  CLIENT_AUDIT_PAGE_RANGE,
  expectedPageRangeForMode,
} from "../src/modules/digital-profile/orion-golden/qa/visual-qa-inspection";
import {
  ORION_ADMIN_REVIEW_ROLES,
  ORION_ADMIN_VIEW_ROLES,
  describeOrionAdminAuthState,
} from "../src/modules/digital-profile/orion-golden/auth/orion-admin-auth";

const CASE_ID = process.env.CASE_ID?.trim() || "cmqzz1vbr00d2vdrsrjsgie2g";
const outDir = join(process.cwd(), "storage", "digital-profile", "qa-r10-10-deploy-preparation");
mkdirSync(outDir, { recursive: true });

const authQa = inspectAdminAuthQa({ workspaceRoot: process.cwd(), caseId: CASE_ID });
const authState = describeOrionAdminAuthState();

const authQaPath = join(outDir, "r10-10a-admin-auth-qa.json");
const priorAuthQa = existsSync(authQaPath)
  ? JSON.parse(readFileSync(authQaPath, "utf-8"))
  : null;

const remainingBlockers: Array<{ id: string; severity: string; detail: string }> = [];
if (!authQa.passed) {
  remainingBlockers.push({
    id: authQa.verdict,
    severity: "blocker",
    detail: authQa.issues.join(", ") || authQa.verdict,
  });
}

const finalVerdict =
  authQa.verdict === "ADMIN_AUTH_READY"
    ? "DEPLOY_PREP_READY"
    : authQa.verdict === "ADMIN_AUTH_READY_WITH_MINOR_WARNINGS"
      ? "DEPLOY_PREP_READY_WITH_MINOR_WARNINGS"
      : authQa.verdict.startsWith("BLOCKED_")
        ? "BLOCKED_ADMIN_AUTH"
        : "BLOCKED_ADMIN_AUTH";

const artifact = {
  version: "r10-10a-production-readiness-after-auth-v1",
  generatedAt: new Date().toISOString(),
  caseId: CASE_ID,
  branch: "feature/report-quality-r10-10a-admin-auth-hardening",
  baseHead: "4e74d8e",
  authProviderFound: {
    type: "cookie-session (DP_SESSION_COOKIE + HMAC)",
    config: "DIGITAL_PROFILE_AUTH_ENABLED / DIGITAL_PROFILE_SESSION_SECRET",
    meRoute: "/api/digital-profile/auth/me",
    loginRoute: "/api/digital-profile/auth/login",
    middleware: "/admin/digital-profile/:path*",
    orionHelper: "src/modules/digital-profile/orion-golden/auth/orion-admin-auth.ts",
  },
  allowedRoles: {
    viewEvidence: [...ORION_ADMIN_VIEW_ROLES],
    reviewDecideRegenerate: [...ORION_ADMIN_REVIEW_ROLES],
    mappedActions: {
      view: "evidence.viewRaw",
      review: "risk.review",
    },
  },
  routeProtectionMatrix: {
    "/admin/digital-profile/[caseId]/orion-golden/manual-review": {
      middlewareSession: true,
      serverPageGuard: "requireOrionAdminPageAccess",
      clientOnlyAuthSoleProtection: false,
    },
  },
  apiProtectionMatrix: {
    "GET manual-review queue": { guard: "requireOrionAdminApiAccess(view)", unauth: 401, forbidden: 403 },
    "GET manual-review item": { guard: "requireOrionAdminApiAccess(view)", unauth: 401, forbidden: 403, missing: 404 },
    "POST manual-review decision": {
      guard: "requireOrionAdminApiAccess(review)+assertCanReviewEvidence",
      unauth: 401,
      forbidden: 403,
      validation: 400,
    },
    "GET admin-review decisions": { guard: "requireOrionAdminApiAccess(view)", unauth: 401, forbidden: 403 },
    "POST regenerate client content": {
      guard: "requireOrionAdminApiAccess(review)+assertCanRegenerateClientContent",
      rendererInvoked: false,
    },
  },
  featureFlagBehavior: {
    localDevAuthOff: "synthetic SUPER_ADMIN allowed with warning (unless DIGITAL_PROFILE_AUTH_ALLOW_SYNTHETIC=false)",
    stagingProdAuthOff: "fail-closed — middleware redirects; API returns 401; no synthetic actor",
    stagingProdAuthOn: "real session required; weak session secret rejected",
    deployLikeDetection: "NODE_ENV=production | APP_ENV/RAILWAY_ENVIRONMENT/VERCEL_ENV in production|staging|preview | DIGITAL_PROFILE_DEPLOY_LIKE=true",
    currentProcess: authState,
  },
  syntheticSuperAdminBehavior: {
    allowedInDeployLike: false,
    allowedWhenAuthEnabled: false,
    localDevDefaultWhenAuthOff: true,
  },
  missingResourceBehavior: {
    missingCaseArtifacts: 404,
    missingEvidence: 404,
    invalidDecisionPayload: 400,
    unauthenticated: 401,
    unauthorized: 403,
    unexpected: 500,
  },
  artifactCaseScoping: {
    decisionsPathPattern: "storage/digital-profile/qa-r10-orion-golden-parallel/cases/<caseId>/admin-review-decisions.json",
    pathTraversalRejected: true,
    crossCaseBleedPrevented: true,
    legacySharedFileReadCompat: true,
    regenerateWritesToCaseScopedRoot: true,
  },
  pageCountModeSplit: {
    legacy_full: expectedPageRangeForMode("legacy_full"),
    client_audit: CLIENT_AUDIT_PAGE_RANGE,
    flags: ["ORION_CLIENT_AUDIT_MODE=1", "R10_RENDER_FROM_CLIENT_CONTENT=1"],
    note: "33–36 page client-audit decks no longer fail solely on legacy 60–75 target",
  },
  adminAuthQa: {
    verdict: authQa.verdict,
    passed: authQa.passed,
    issues: authQa.issues,
    priorFileVerdict: priorAuthQa?.verdict ?? null,
  },
  remainingBlockers,
  recommendedStagingFlags: {
    DIGITAL_PROFILE_ENABLED: "true",
    DIGITAL_PROFILE_AUTH_ENABLED: "true",
    DIGITAL_PROFILE_SESSION_SECRET: "<strong-random-not-default>",
    DIGITAL_PROFILE_ORION_GOLDEN_ENABLED: "true",
    ORION_CLIENT_AUDIT_MODE: "1",
    R10_RENDER_FROM_CLIENT_CONTENT: "1",
    ORION_ADMIN_REVIEW_DECISION_STORE: "artifact",
    DIGITAL_PROFILE_AUTH_ALLOW_SYNTHETIC: "false",
  },
  finalVerdict,
  recommendedNextStep:
    finalVerdict === "DEPLOY_PREP_READY" || finalVerdict === "DEPLOY_PREP_READY_WITH_MINOR_WARNINGS"
      ? "R10.10b final staging smoke with DIGITAL_PROFILE_AUTH_ENABLED=true, then staging deploy"
      : "fix remaining auth blockers before staging",
};

const outPath = join(outDir, "r10-10a-production-readiness-after-auth.json");
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8");
console.log(`[INFO] wrote ${outPath}`);
console.log(`[INFO] authQa=${authQa.verdict}`);
console.log(`[INFO] finalVerdict=${finalVerdict}`);
process.exit(authQa.passed ? 0 : 1);
