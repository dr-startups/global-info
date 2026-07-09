/**
 * R10.10a — Admin auth hardening QA (static + policy checks).
 * Does not print secrets. Does not create fake approvals. Does not invoke renderer.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isDeployLikeEnvironment,
  isSyntheticAuthBypassAllowed,
} from "../../auth/auth-config";
import { normalizeError, NotFoundError, ValidationError } from "../../http/errors";
import {
  adminReviewDecisionsPath,
  caseScopedArtifactRoot,
  ORION_GOLDEN_QA_STORAGE_ROOT,
  sanitizeCaseIdForPath,
} from "../evidence/admin-review-decision-store";
import { validateAdminReviewDecisionInput } from "../evidence/admin-review-decision-validation";
import {
  CLIENT_AUDIT_PAGE_RANGE,
  expectedPageRangeForMode,
  resolveOrionVisualReportMode,
} from "./visual-qa-inspection";

export type AdminAuthQaVerdict =
  | "ADMIN_AUTH_READY"
  | "ADMIN_AUTH_READY_WITH_MINOR_WARNINGS"
  | "BLOCKED_NO_AUTH_PROVIDER"
  | "BLOCKED_ADMIN_PAGE_UNPROTECTED"
  | "BLOCKED_API_UNPROTECTED"
  | "BLOCKED_ROLE_CHECK_MISSING"
  | "BLOCKED_AUTH_BYPASS_IN_PROD"
  | "BLOCKED_SYNTHETIC_SUPER_ADMIN"
  | "BLOCKED_MISSING_RESOURCE_500"
  | "BLOCKED_CASE_SCOPE_DECISIONS"
  | "BLOCKED_SECRET_LOGGING";

function check(id: string, passed: boolean, detail: string) {
  return { id, passed, detail };
}

export function inspectAdminAuthQa(input?: { workspaceRoot?: string; caseId?: string }): {
  version: "r10-10a-admin-auth-qa-v1";
  passed: boolean;
  verdict: AdminAuthQaVerdict;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  metrics?: Record<string, string | number | boolean>;
} {
  const root = input?.workspaceRoot ?? process.cwd();
  const caseId = input?.caseId ?? "cmqzz1vbr00d2vdrsrjsgie2g";
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const authConfigPath = join(root, "src/modules/digital-profile/auth/auth-config.ts");
  const guardPath = join(root, "src/modules/digital-profile/auth/guard.ts");
  const orionAuthPath = join(root, "src/modules/digital-profile/orion-golden/auth/orion-admin-auth.ts");
  const middlewarePath = join(root, "src/middleware.ts");
  const pagePath = join(
    root,
    "src/app/admin/digital-profile/[caseId]/orion-golden/manual-review/page.tsx"
  );
  const apiQueue = join(
    root,
    "src/app/api/digital-profile/cases/[id]/orion-golden/manual-review/route.ts"
  );
  const apiItem = join(
    root,
    "src/app/api/digital-profile/cases/[id]/orion-golden/manual-review/[evidenceId]/route.ts"
  );
  const apiDecisions = join(
    root,
    "src/app/api/digital-profile/cases/[id]/orion-golden/admin-review-decisions/route.ts"
  );
  const apiRegen = join(
    root,
    "src/app/api/digital-profile/cases/[id]/orion-golden/client-content/regenerate/route.ts"
  );
  const errorsPath = join(root, "src/modules/digital-profile/http/errors.ts");
  const storePath = join(
    root,
    "src/modules/digital-profile/orion-golden/evidence/admin-review-decision-store.ts"
  );
  const visualPath = join(
    root,
    "src/modules/digital-profile/orion-golden/qa/visual-qa-inspection.ts"
  );

  checks.push(check("auth-provider-present", existsSync(authConfigPath) && existsSync(guardPath), "session cookie + roles"));
  if (!existsSync(authConfigPath) || !existsSync(guardPath)) issues.push("no-auth-provider");

  checks.push(check("orion-admin-auth-helper", existsSync(orionAuthPath), orionAuthPath));
  if (!existsSync(orionAuthPath)) issues.push("role-check-missing");

  const pageSrc = existsSync(pagePath) ? readFileSync(pagePath, "utf-8") : "";
  const pageProtected = /requireOrionAdminPageAccess/.test(pageSrc);
  checks.push(check("admin-page-server-guard", pageProtected, "requireOrionAdminPageAccess"));
  if (!pageProtected) issues.push("page-unprotected");

  const queueSrc = existsSync(apiQueue) ? readFileSync(apiQueue, "utf-8") : "";
  const itemSrc = existsSync(apiItem) ? readFileSync(apiItem, "utf-8") : "";
  const decSrc = existsSync(apiDecisions) ? readFileSync(apiDecisions, "utf-8") : "";
  const regenSrc = existsSync(apiRegen) ? readFileSync(apiRegen, "utf-8") : "";

  const apisProtected =
    /requireOrionAdminApiAccess/.test(queueSrc) &&
    /requireOrionAdminApiAccess/.test(itemSrc) &&
    /requireOrionAdminApiAccess/.test(decSrc) &&
    /requireOrionAdminApiAccess/.test(regenSrc);
  checks.push(check("apis-use-orion-admin-guard", apisProtected, "all four ORION admin routes"));
  if (!apisProtected) issues.push("api-unprotected");

  checks.push(
    check(
      "decision-post-role-review",
      /assertCanReviewEvidence|risk\.review|"review"/.test(itemSrc),
      "POST requires review access"
    )
  );
  checks.push(
    check(
      "regenerate-role-review",
      /assertCanRegenerateClientContent|"review"/.test(regenSrc),
      "regenerate requires review access"
    )
  );
  checks.push(
    check(
      "regenerate-no-renderer",
      /rendererInvoked:\s*false/.test(regenSrc) &&
        !/renderOrionGolden|rendered-client\.(pdf|pptx)/.test(regenSrc),
      "rendererInvoked=false"
    )
  );

  const mw = existsSync(middlewarePath) ? readFileSync(middlewarePath, "utf-8") : "";
  checks.push(
    check(
      "middleware-fail-closed-deploy-like",
      /isDeployLikeEnvironment/.test(mw) && /auth_required|LOGIN_PATH/.test(mw),
      "deploy-like redirects when auth off"
    )
  );

  const guardSrc = existsSync(guardPath) ? readFileSync(guardPath, "utf-8") : "";
  const syntheticBlocked =
    /isSyntheticAuthBypassAllowed/.test(guardSrc) &&
    /isDeployLikeEnvironment/.test(guardSrc) &&
    /UnauthorizedError/.test(guardSrc);
  checks.push(
    check("synthetic-super-admin-blocked-deploy-like", syntheticBlocked, "guard fail-closed")
  );
  if (!syntheticBlocked) issues.push("synthetic-super-admin");

  // Policy unit checks (current process env — document expected deploy-like behavior)
  const deployLikeProd = isDeployLikeEnvironment({
    ...process.env,
    NODE_ENV: "production",
    DIGITAL_PROFILE_DEPLOY_LIKE: undefined,
  } as NodeJS.ProcessEnv);
  const bypassInProd = isSyntheticAuthBypassAllowed({
    ...process.env,
    NODE_ENV: "production",
    DIGITAL_PROFILE_AUTH_ENABLED: "false",
    DIGITAL_PROFILE_AUTH_ALLOW_SYNTHETIC: "true",
  } as NodeJS.ProcessEnv);
  checks.push(
    check(
      "synthetic-bypass-false-in-production",
      deployLikeProd && bypassInProd === false,
      `deployLike=${deployLikeProd} bypass=${bypassInProd}`
    )
  );
  if (bypassInProd) issues.push("auth-bypass-in-prod");

  // Missing resource → 404 mapping
  const errorsSrc = existsSync(errorsPath) ? readFileSync(errorsPath, "utf-8") : "";
  checks.push(
    check(
      "missing-resource-mapped-404",
      /manual-review-item-not-found/.test(errorsSrc) && /NotFoundError/.test(errorsSrc),
      "normalizeError maps workflow misses"
    )
  );
  const mappedItem = normalizeError(new Error("manual-review-item-not-found:x"));
  const mappedQueue = normalizeError(new Error("manual-review-queue-missing"));
  checks.push(
    check(
      "normalize-item-404",
      mappedItem instanceof NotFoundError && mappedItem.status === 404,
      mappedItem.code
    )
  );
  checks.push(
    check(
      "normalize-queue-404",
      mappedQueue instanceof NotFoundError && mappedQueue.status === 404,
      mappedQueue.code
    )
  );
  if (!(mappedItem instanceof NotFoundError) || !(mappedQueue instanceof NotFoundError)) {
    issues.push("missing-resource-500");
  }

  const caveatFail = validateAdminReviewDecisionInput({
    status: "APPROVED_WITH_CAVEAT",
    caveatText: "",
  });
  checks.push(
    check(
      "invalid-decision-400-shape",
      caveatFail.ok === false,
      "APPROVED_WITH_CAVEAT requires caveat"
    )
  );
  const asValidation = new ValidationError(caveatFail.errors.join("; "));
  checks.push(check("validation-status-400", asValidation.status === 400, "VALIDATION_ERROR"));

  // Case-scoped decisions
  const storeSrc = existsSync(storePath) ? readFileSync(storePath, "utf-8") : "";
  let caseScopedOk = false;
  try {
    const pathA = adminReviewDecisionsPath(caseId);
    const pathB = adminReviewDecisionsPath("othercaseid123");
    const scopedRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
    caseScopedOk =
      pathA.includes(`${join("cases", caseId)}`) &&
      pathA !== pathB &&
      scopedRoot.includes(caseId) &&
      /sanitizeCaseIdForPath|caseScopedArtifactRoot/.test(storeSrc);
    sanitizeCaseIdForPath(caseId);
    let traversalBlocked = false;
    try {
      sanitizeCaseIdForPath("../etc/passwd");
    } catch {
      traversalBlocked = true;
    }
    checks.push(check("case-scoped-decision-paths", caseScopedOk, pathA));
    checks.push(check("path-traversal-rejected", traversalBlocked, "sanitizeCaseIdForPath"));
    if (!caseScopedOk || !traversalBlocked) issues.push("case-scope-decisions");
  } catch (err) {
    checks.push(check("case-scoped-decision-paths", false, String(err)));
    issues.push("case-scope-decisions");
  }

  // Page-count mode split
  const visualSrc = existsSync(visualPath) ? readFileSync(visualPath, "utf-8") : "";
  const modeClient = resolveOrionVisualReportMode({
    env: { ...process.env, R10_RENDER_FROM_CLIENT_CONTENT: "1", ORION_CLIENT_AUDIT_MODE: undefined },
  });
  const modeLegacy = resolveOrionVisualReportMode({
    env: {
      ...process.env,
      R10_RENDER_FROM_CLIENT_CONTENT: undefined,
      ORION_CLIENT_AUDIT_MODE: undefined,
    },
  });
  const clientRange = expectedPageRangeForMode("client_audit");
  checks.push(
    check(
      "page-count-mode-split",
      modeClient === "client_audit" &&
        modeLegacy === "legacy_full" &&
        clientRange.min === CLIENT_AUDIT_PAGE_RANGE.min &&
        /client_audit/.test(visualSrc),
      `client=${modeClient} range=${clientRange.min}-${clientRange.max}`
    )
  );

  // No secret logging in orion auth helper
  const orionAuthSrc = existsSync(orionAuthPath) ? readFileSync(orionAuthPath, "utf-8") : "";
  const secretLog =
    /console\.(log|info|debug).*SESSION_SECRET|console\.(log|info).*API_KEY|console\.(log|info).*password/i.test(
      orionAuthSrc + guardSrc
    );
  checks.push(check("no-secret-logging", !secretLog, "no secret console logs"));
  if (secretLog) issues.push("secret-logging");

  // Pending / fake approvals — static regenerate + validation still present
  checks.push(
    check(
      "no-fake-approvals-in-routes",
      !/qaSampleOnly:\s*true/.test(itemSrc + regenSrc),
      "routes do not write sample approvals"
    )
  );

  let verdict: AdminAuthQaVerdict = "ADMIN_AUTH_READY";
  if (issues.includes("no-auth-provider")) verdict = "BLOCKED_NO_AUTH_PROVIDER";
  else if (issues.includes("page-unprotected")) verdict = "BLOCKED_ADMIN_PAGE_UNPROTECTED";
  else if (issues.includes("api-unprotected")) verdict = "BLOCKED_API_UNPROTECTED";
  else if (issues.includes("role-check-missing")) verdict = "BLOCKED_ROLE_CHECK_MISSING";
  else if (issues.includes("auth-bypass-in-prod")) verdict = "BLOCKED_AUTH_BYPASS_IN_PROD";
  else if (issues.includes("synthetic-super-admin")) verdict = "BLOCKED_SYNTHETIC_SUPER_ADMIN";
  else if (issues.includes("missing-resource-500")) verdict = "BLOCKED_MISSING_RESOURCE_500";
  else if (issues.includes("case-scope-decisions")) verdict = "BLOCKED_CASE_SCOPE_DECISIONS";
  else if (issues.includes("secret-logging")) verdict = "BLOCKED_SECRET_LOGGING";
  else if (issues.length > 0) verdict = "ADMIN_AUTH_READY_WITH_MINOR_WARNINGS";

  const passed =
    verdict === "ADMIN_AUTH_READY" || verdict === "ADMIN_AUTH_READY_WITH_MINOR_WARNINGS";

  return {
    version: "r10-10a-admin-auth-qa-v1",
    passed,
    verdict,
    issues,
    checks,
    metrics: {
      caseId,
      pageProtected,
      apisProtected,
      clientAuditPageMin: CLIENT_AUDIT_PAGE_RANGE.min,
      clientAuditPageMax: CLIENT_AUDIT_PAGE_RANGE.max,
    },
  };
}

export function writeAdminAuthQaArtifact(workspaceRoot = process.cwd(), caseId?: string) {
  const full = {
    ...inspectAdminAuthQa({ workspaceRoot, caseId }),
    generatedAt: new Date().toISOString(),
  };
  const outDir = join(workspaceRoot, "storage/digital-profile/qa-r10-10-deploy-preparation");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "r10-10a-admin-auth-qa.json");
  writeFileSync(outPath, `${JSON.stringify(full, null, 2)}\n`, "utf-8");
  return { outPath, ...full };
}
