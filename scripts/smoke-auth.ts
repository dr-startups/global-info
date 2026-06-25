/**
 * Smoke test for Digital Profile auth + RBAC (Stage M1).
 *
 * Pure / in-process (no server, no DB): exercises the real permission matrix,
 * password hashing, signed-session sign/verify, case-access resolution and the
 * auth-config production guard. The full HTTP login/redirect flow is covered by
 * the manual QA checklist in docs/digital-profile/FINAL_QA.md.
 *
 * Run: `npm run smoke:auth`
 */

import { can, type DpAction, type DpRole } from "../src/modules/digital-profile/auth/roles";
import { hashPassword, verifyPassword } from "../src/modules/digital-profile/auth/password";
import {
  createSessionToken,
  verifySessionToken,
} from "../src/modules/digital-profile/auth/session";
import {
  accessLevelSatisfies,
  resolveCaseAccess,
} from "../src/modules/digital-profile/auth/access-rules";
import {
  assertAuthConfigSafe,
  getAuthConfig,
} from "../src/modules/digital-profile/auth/auth-config";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  console.log("smoke:auth — Stage M1 auth + RBAC");

  // 1. Permission matrix --------------------------------------------------
  const allow = (r: DpRole, a: DpAction) => can(r, a);
  check("super_admin can manage users", allow("SUPER_ADMIN", "users.manage"));
  check("super_admin can view audit logs", allow("SUPER_ADMIN", "auditLogs.view"));
  check("admin can create case", allow("ADMIN", "case.create"));
  check("admin can delete case", allow("ADMIN", "case.delete"));
  check("analyst can run agents", allow("ANALYST", "agents.run"));
  check("analyst CANNOT delete case", !allow("ANALYST", "case.delete"));
  check("analyst CANNOT run real providers", !allow("ANALYST", "agents.runReal"));
  check("admin can run real providers", allow("ADMIN", "agents.runReal"));
  check("reviewer can review findings", allow("REVIEWER", "risk.review"));
  check("reviewer can generate client report", allow("REVIEWER", "report.generateClient"));
  check("reviewer CANNOT classify", !allow("REVIEWER", "risk.classify"));
  check("analyst CANNOT review findings", !allow("ANALYST", "risk.review"));
  check("client_viewer can download client report", allow("CLIENT_VIEWER", "report.downloadClient"));
  check("client_viewer CANNOT view raw evidence", !allow("CLIENT_VIEWER", "evidence.viewRaw"));
  check("client_viewer CANNOT download internal report", !allow("CLIENT_VIEWER", "report.downloadInternal"));
  check("client_viewer CANNOT create case", !allow("CLIENT_VIEWER", "case.create"));

  // 2. Password hashing ----------------------------------------------------
  const hash = await hashPassword("demo-Analyst-12345");
  check("password hash is not plaintext", !hash.includes("demo-Analyst-12345"));
  check("password verify (correct)", await verifyPassword("demo-Analyst-12345", hash));
  check("password verify (wrong) fails", !(await verifyPassword("wrong-password", hash)));
  check("password verify (garbage hash) fails", !(await verifyPassword("x", "not-a-hash")));

  // 3. Session tokens ------------------------------------------------------
  const secret = "smoke-secret-0123456789abcdef";
  const token = await createSessionToken("user-123", secret, 3600);
  const payload = await verifySessionToken(token, secret);
  check("session verify roundtrip uid", payload?.uid === "user-123");
  check("session wrong secret rejected", (await verifySessionToken(token, "other-secret")) === null);
  check("session tampered token rejected", (await verifySessionToken(token + "x", secret)) === null);
  check("session empty token rejected", (await verifySessionToken("", secret)) === null);
  const expired = await createSessionToken("user-123", secret, -10);
  check("session expired token rejected", (await verifySessionToken(expired, secret)) === null);

  // 4. Case access resolution ---------------------------------------------
  check("staff (admin) sees any case", resolveCaseAccess("ADMIN", null).canView);
  check("analyst sees any case", resolveCaseAccess("ANALYST", null).canView);
  check("client_viewer without grant -> no access", !resolveCaseAccess("CLIENT_VIEWER", null).canView);
  check("client_viewer with grant -> access", resolveCaseAccess("CLIENT_VIEWER", "VIEWER").canView);
  check("level VIEWER does not satisfy EDITOR", !accessLevelSatisfies("VIEWER", "EDITOR"));
  check("level OWNER satisfies VIEWER", accessLevelSatisfies("OWNER", "VIEWER"));
  check("null level satisfies nothing", !accessLevelSatisfies(null, "VIEWER"));

  // 5. Auth config / production guard -------------------------------------
  check("auth disabled by default in this process", getAuthConfig().enabled === false);
  check("assertAuthConfigSafe no-op when disabled", (() => {
    try { assertAuthConfigSafe(); return true; } catch { return false; }
  })());
  // Production + enabled + default secret must fail closed.
  const savedEnv = process.env.NODE_ENV;
  const savedEnabled = process.env.DIGITAL_PROFILE_AUTH_ENABLED;
  const savedSecret = process.env.DIGITAL_PROFILE_SESSION_SECRET;
  try {
    (process.env as Record<string, string>).NODE_ENV = "production";
    process.env.DIGITAL_PROFILE_AUTH_ENABLED = "true";
    delete process.env.DIGITAL_PROFILE_SESSION_SECRET;
    let threw = false;
    try { assertAuthConfigSafe(); } catch { threw = true; }
    check("prod + enabled + default secret fails closed", threw);
    // With a strong secret it should pass.
    process.env.DIGITAL_PROFILE_SESSION_SECRET = "a-strong-production-secret-value";
    let ok = true;
    try { assertAuthConfigSafe(); } catch { ok = false; }
    check("prod + enabled + strong secret allowed", ok);
  } finally {
    if (savedEnv === undefined) delete (process.env as Record<string, string>).NODE_ENV;
    else (process.env as Record<string, string>).NODE_ENV = savedEnv;
    if (savedEnabled === undefined) delete process.env.DIGITAL_PROFILE_AUTH_ENABLED;
    else process.env.DIGITAL_PROFILE_AUTH_ENABLED = savedEnabled;
    if (savedSecret === undefined) delete process.env.DIGITAL_PROFILE_SESSION_SECRET;
    else process.env.DIGITAL_PROFILE_SESSION_SECRET = savedSecret;
  }

  console.log("");
  if (failures > 0) {
    console.error(`smoke:auth FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("smoke:auth PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
