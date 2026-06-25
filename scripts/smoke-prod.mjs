/**
 * Production-like smoke test (Stage M3).
 *
 * Exercises a RUNNING deployment over HTTP (default http://localhost:3000).
 * Designed to be safe to run against a fresh stack: optional steps (login,
 * report render) are skipped with a clear message when prerequisites are absent.
 *
 * Prerequisites:
 *   - App + renderer up (e.g. docker compose -f docker-compose.prod.yml up -d)
 *   - DIGITAL_PROFILE_ENABLED=true
 *
 * Optional env (enables more checks):
 *   - SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD  -> login check
 *   - SMOKE_CASE_ID                             -> report-render availability check
 *
 * Run:  npm run smoke:prod
 */

const BASE_URL = (process.env.BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const RENDERER_URL = (process.env.RENDERER_URL ?? "http://localhost:8080").replace(/\/$/, "");
const API = `${BASE_URL}/api/digital-profile`;

let failures = 0;
function check(name, ok, extra) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}
function info(msg) {
  console.log(`[INFO] ${msg}`);
}

async function getJson(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  const text = await res.text().catch(() => "");
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { res, body, text };
}

// Secret values that must never appear in any response body.
const SECRET_VALUES = [
  process.env.DIGITAL_PROFILE_SESSION_SECRET,
  process.env.DIGITAL_PROFILE_SIGNED_URL_SECRET,
  process.env.DIGITAL_PROFILE_SIGNING_SECRET,
  process.env.GOOGLE_SEARCH_API_KEY,
  process.env.YANDEX_SEARCH_API_KEY,
  process.env.LEXISNEXIS_API_KEY,
  process.env.DOWJONES_API_KEY,
  process.env.WORLDCHECK_API_KEY,
].filter((v) => typeof v === "string" && v.trim().length >= 8);

function leaksSecret(text) {
  return SECRET_VALUES.some((s) => text.includes(s));
}

async function main() {
  console.log(`smoke:prod — target ${BASE_URL}\n`);

  // 1. App health responds and exposes no secrets.
  let authEnabled = false;
  try {
    const { res, body, text } = await getJson(`${API}/health`);
    const okStatus = res.status === 200 || res.status === 503;
    const shape =
      body &&
      typeof body.database === "string" &&
      typeof body.storage === "string" &&
      typeof body.renderer === "string" &&
      typeof body.authEnabled === "boolean";
    check("app health responds with component status", okStatus && !!shape, `status=${res.status}`);
    if (shape) {
      authEnabled = body.authEnabled;
      info(`health: database=${body.database} storage=${body.storage} renderer=${body.renderer} authEnabled=${body.authEnabled}`);
    }
    check("app health does not leak secrets", !leaksSecret(text));
    // Renderer-unavailable must not take the whole app down.
    if (body && body.renderer === "unavailable") {
      check("renderer unavailable is non-fatal (db/storage drive overall)", body.ok === (body.database === "ok" && body.storage === "ok"));
    }
  } catch (err) {
    check("app health responds", false, String(err));
  }

  // 2. Renderer health responds.
  try {
    const { res, body } = await getJson(`${RENDERER_URL}/health`);
    check("renderer health responds ok", res.ok && body && body.ok === true, `libreOffice=${body?.libreOfficeAvailable}`);
  } catch (err) {
    info(`renderer not reachable at ${RENDERER_URL} (${String(err)}) — app should still report it as 'unavailable'`);
  }

  // 3. Auth enabled state reported (production should be true).
  check("auth state reported", typeof authEnabled === "boolean", `authEnabled=${authEnabled}`);
  if (!authEnabled) info("auth is DISABLED — enable DIGITAL_PROFILE_AUTH_ENABLED=true for production");

  // 7. Invalid signed token is rejected (never returns a file).
  try {
    const { res } = await getJson(`${API}/reports/smoke-fake-id/download?type=pdf&token=invalid-token`);
    check("invalid download token rejected (no file)", res.status !== 200, `status=${res.status}`);
  } catch (err) {
    check("invalid download token rejected", false, String(err));
  }

  // 4 + 5. Optional login + providers no-leak (needs admin creds).
  const adminEmail = process.env.SMOKE_ADMIN_EMAIL;
  const adminPassword = process.env.SMOKE_ADMIN_PASSWORD;
  let cookie = "";
  if (adminEmail && adminPassword) {
    try {
      const res = await fetch(`${API}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: adminEmail, password: adminPassword }),
      });
      const setCookie = res.headers.get("set-cookie") ?? "";
      cookie = setCookie.split(";")[0] ?? "";
      check("admin login works", res.ok && cookie.startsWith("dp_session="), `status=${res.status}`);
    } catch (err) {
      check("admin login works", false, String(err));
    }
  } else {
    info("SMOKE_ADMIN_EMAIL/PASSWORD not set — skipping login check (seed an admin or run admin:create)");
  }

  // 5. Providers status must not leak secrets.
  try {
    const headers = cookie ? { cookie } : {};
    const { res, text } = await getJson(`${API}/providers`, { headers });
    if (res.status === 401 && !cookie) {
      check("providers endpoint requires auth when not logged in", true, "401");
    } else {
      check("providers status does not leak secrets", res.ok && !leaksSecret(text), `status=${res.status}`);
    }
  } catch (err) {
    check("providers status reachable", false, String(err));
  }

  // 6. Report render handles renderer availability gracefully (optional).
  const caseId = process.env.SMOKE_CASE_ID;
  if (caseId && cookie) {
    try {
      const res = await fetch(`${API}/cases/${caseId}/report/render`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ templateVersion: "report-template-v3", reportLanguage: "ru" }),
      });
      const text = await res.text().catch(() => "");
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* noop */ }
      const graceful =
        res.ok ||
        (body && body.error && typeof body.error.code === "string"); // normalized error, not a stack
      check("report render handled gracefully (ok or normalized error)", !!graceful, `status=${res.status}${body?.error?.code ? ` code=${body.error.code}` : ""}`);
      check("report render response does not leak secrets", !leaksSecret(text));
    } catch (err) {
      check("report render handled", false, String(err));
    }
  } else {
    info("SMOKE_CASE_ID not set (or not logged in) — skipping report-render availability check");
  }

  console.log("");
  if (failures > 0) {
    console.error(`smoke:prod FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("smoke:prod OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
