/**
 * R10.10b — Live auth-enabled API smoke against running dp-app.
 * Does not print secrets. Uses demo users created for this smoke only.
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.R10_SMOKE_BASE_URL?.trim() || "http://localhost:3000";
const CASE_ID = process.env.CASE_ID?.trim() || "cmqzz1vbr00d2vdrsrjsgie2g";
const ADMIN_EMAIL = process.env.R10_SMOKE_ADMIN_EMAIL || "r10b-admin@demo.local";
const ADMIN_PASSWORD = process.env.R10_SMOKE_ADMIN_PASSWORD || "R10b-Demo-Admin-12345";
const VIEWER_EMAIL = process.env.R10_SMOKE_VIEWER_EMAIL || "r10b-viewer@demo.local";
const VIEWER_PASSWORD = process.env.R10_SMOKE_VIEWER_PASSWORD || "R10b-Demo-Viewer-12345";

type Check = { id: string; passed: boolean; detail: string; status?: number };

function check(id: string, passed: boolean, detail: string, status?: number): Check {
  return { id, passed, detail, status };
}

function parseSetCookie(res: Response): string | null {
  // Node fetch may expose getSetCookie
  const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = anyHeaders.getSetCookie?.() ?? [];
  if (list.length) {
    const raw = list.find((c) => c.startsWith("dp_session=")) ?? list[0];
    return raw.split(";")[0];
  }
  const single = res.headers.get("set-cookie");
  if (!single) return null;
  return single.split(";")[0];
}

async function jsonFetch(
  path: string,
  init: RequestInit & { cookie?: string } = {}
): Promise<{ status: number; body: any; cookie?: string | null; location?: string | null }> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string>),
  };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return {
    status: res.status,
    body,
    cookie: parseSetCookie(res),
    location: res.headers.get("location"),
  };
}

async function login(email: string, password: string) {
  const res = await jsonFetch("/api/digital-profile/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return res;
}

async function main() {
  const checks: Check[] = [];

  const meUnauth = await jsonFetch("/api/digital-profile/auth/me");
  checks.push(
    check(
      "auth-me-unauthenticated",
      meUnauth.status === 200 && meUnauth.body?.data?.authEnabled === true && meUnauth.body?.data?.user == null,
      "user=null authEnabled=true",
      meUnauth.status
    )
  );

  const queueUnauth = await jsonFetch(
    `/api/digital-profile/cases/${CASE_ID}/orion-golden/manual-review`
  );
  checks.push(
    check(
      "queue-unauth-401",
      queueUnauth.status === 401 && queueUnauth.body?.error?.code === "UNAUTHORIZED",
      queueUnauth.body?.error?.code ?? "none",
      queueUnauth.status
    )
  );

  const pageUnauth = await jsonFetch(
    `/admin/digital-profile/${CASE_ID}/orion-golden/manual-review`
  );
  checks.push(
    check(
      "page-unauth-redirect",
      pageUnauth.status === 307 || pageUnauth.status === 302,
      `status=${pageUnauth.status} loc=${pageUnauth.location ?? ""}`,
      pageUnauth.status
    )
  );

  const adminLogin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  const adminCookie = adminLogin.cookie;
  checks.push(
    check(
      "admin-login",
      adminLogin.status === 200 && Boolean(adminCookie?.startsWith("dp_session=")),
      `status=${adminLogin.status} role=${adminLogin.body?.data?.role ?? "?"}`,
      adminLogin.status
    )
  );

  if (adminCookie) {
    const meAdmin = await jsonFetch("/api/digital-profile/auth/me", { cookie: adminCookie });
    checks.push(
      check(
        "auth-me-admin",
        meAdmin.status === 200 && meAdmin.body?.data?.user?.role === "SUPER_ADMIN",
        `role=${meAdmin.body?.data?.user?.role}`,
        meAdmin.status
      )
    );
    checks.push(
      check(
        "no-synthetic-admin",
        meAdmin.body?.data?.user?.synthetic !== true && meAdmin.body?.data?.user?.id !== "dev-no-auth",
        `id=${meAdmin.body?.data?.user?.id}`
      )
    );

    const queue = await jsonFetch(`/api/digital-profile/cases/${CASE_ID}/orion-golden/manual-review`, {
      cookie: adminCookie,
    });
    const items = queue.body?.data?.items ?? [];
    checks.push(
      check(
        "queue-authorized",
        queue.status === 200 && Array.isArray(items) && items.length > 0,
        `items=${items.length}`,
        queue.status
      )
    );

    const evidenceId = items[0]?.evidenceId as string | undefined;
    if (evidenceId) {
      const detail = await jsonFetch(
        `/api/digital-profile/cases/${CASE_ID}/orion-golden/manual-review/${encodeURIComponent(evidenceId)}`,
        { cookie: adminCookie }
      );
      checks.push(
        check(
          "detail-authorized",
          detail.status === 200 && detail.body?.data?.evidenceId === evidenceId,
          evidenceId,
          detail.status
        )
      );

      const badCaveat = await jsonFetch(
        `/api/digital-profile/cases/${CASE_ID}/orion-golden/manual-review/${encodeURIComponent(evidenceId)}`,
        {
          method: "POST",
          cookie: adminCookie,
          body: JSON.stringify({ status: "APPROVED_WITH_CAVEAT", caveatText: "" }),
        }
      );
      checks.push(
        check(
          "invalid-decision-400",
          badCaveat.status === 400 && badCaveat.body?.error?.code === "VALIDATION_ERROR",
          badCaveat.body?.error?.message ?? "",
          badCaveat.status
        )
      );

      const badWrong = await jsonFetch(
        `/api/digital-profile/cases/${CASE_ID}/orion-golden/manual-review/${encodeURIComponent(evidenceId)}`,
        {
          method: "POST",
          cookie: adminCookie,
          body: JSON.stringify({ status: "WRONG_SUBJECT" }),
        }
      );
      checks.push(
        check(
          "wrong-subject-note-400",
          badWrong.status === 400,
          badWrong.body?.error?.message ?? "",
          badWrong.status
        )
      );

      // Valid NEEDS_MORE_SOURCES then restore PENDING — no fake approvals
      const validNeeds = await jsonFetch(
        `/api/digital-profile/cases/${CASE_ID}/orion-golden/manual-review/${encodeURIComponent(evidenceId)}`,
        {
          method: "POST",
          cookie: adminCookie,
          body: JSON.stringify({
            status: "NEEDS_MORE_SOURCES",
            reviewerNote: "R10.10b smoke — temporary, will restore PENDING",
            requestedSources: ["additional-source-check"],
          }),
        }
      );
      checks.push(
        check(
          "valid-decision-accepted",
          validNeeds.status === 200,
          `status=${validNeeds.status}`,
          validNeeds.status
        )
      );
      const restore = await jsonFetch(
        `/api/digital-profile/cases/${CASE_ID}/orion-golden/manual-review/${encodeURIComponent(evidenceId)}`,
        {
          method: "POST",
          cookie: adminCookie,
          body: JSON.stringify({
            status: "PENDING",
            reviewerNote: "R10.10b smoke restore PENDING",
            overwriteConfirmed: true,
          }),
        }
      );
      checks.push(
        check("restore-pending", restore.status === 200, `status=${restore.status}`, restore.status)
      );
    }

    const missingEv = await jsonFetch(
      `/api/digital-profile/cases/${CASE_ID}/orion-golden/manual-review/does-not-exist-evidence`,
      { cookie: adminCookie }
    );
    checks.push(
      check(
        "missing-evidence-404",
        missingEv.status === 404 && missingEv.body?.error?.code === "NOT_FOUND",
        missingEv.body?.error?.code ?? String(missingEv.status),
        missingEv.status
      )
    );

    const missingCase = await jsonFetch(
      `/api/digital-profile/cases/doesnotexist000000000001/orion-golden/manual-review`,
      { cookie: adminCookie }
    );
    checks.push(
      check(
        "missing-case-404",
        missingCase.status === 404,
        missingCase.body?.error?.code ?? String(missingCase.status),
        missingCase.status
      )
    );

    const decisions = await jsonFetch(
      `/api/digital-profile/cases/${CASE_ID}/orion-golden/admin-review-decisions`,
      { cookie: adminCookie }
    );
    checks.push(
      check(
        "decisions-authorized",
        decisions.status === 200 && Array.isArray(decisions.body?.data?.decisions),
        `count=${decisions.body?.data?.decisions?.length ?? 0}`,
        decisions.status
      )
    );

    const regen = await jsonFetch(
      `/api/digital-profile/cases/${CASE_ID}/orion-golden/client-content/regenerate`,
      { method: "POST", cookie: adminCookie, body: "{}" }
    );
    checks.push(
      check(
        "regen-authorized-no-renderer",
        regen.status === 200 && regen.body?.data?.rendererInvoked === false,
        `rendererInvoked=${regen.body?.data?.rendererInvoked}`,
        regen.status
      )
    );
  }

  // Unauthorized role
  const viewerLogin = await login(VIEWER_EMAIL, VIEWER_PASSWORD);
  if (viewerLogin.status === 200 && viewerLogin.cookie) {
    const q = await jsonFetch(`/api/digital-profile/cases/${CASE_ID}/orion-golden/manual-review`, {
      cookie: viewerLogin.cookie,
    });
    checks.push(
      check(
        "viewer-forbidden-403",
        q.status === 403 && q.body?.error?.code === "FORBIDDEN",
        q.body?.error?.code ?? String(q.status),
        q.status
      )
    );
  } else {
    checks.push(
      check("viewer-forbidden-403", false, `viewer login failed status=${viewerLogin.status}`, viewerLogin.status)
    );
  }

  const passed = checks.every((c) => c.passed);
  const outDir = join(process.cwd(), "storage/digital-profile/qa-r10-10-deploy-preparation");
  mkdirSync(outDir, { recursive: true });
  const out = {
    version: "r10-10b-live-auth-api-smoke-v1",
    generatedAt: new Date().toISOString(),
    base: BASE,
    caseId: CASE_ID,
    passed,
    checks,
  };
  writeFileSync(join(outDir, "r10-10b-live-auth-api-smoke.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`[INFO] passed=${passed}`);
  for (const c of checks) {
    console.log(`[${c.passed ? "PASS" : "FAIL"}] ${c.id} — ${c.detail}`);
  }
  process.exit(passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
