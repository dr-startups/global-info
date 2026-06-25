/**
 * Smoke test for the real Wikipedia connector (Stage H1).
 *
 * Prerequisites:
 *   1. DIGITAL_PROFILE_ENABLED="true" in .env
 *   2. Database migrated (npm run db:migrate)
 *   3. Dev server running (npm run dev)
 *   4. Network access to *.wikipedia.org for the "enabled" path. If the network
 *      is unavailable, the agent must still fail gracefully (FAILED, no crash).
 *
 * Run:  node scripts/smoke-wikipedia.mjs
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-wikipedia" };

let failures = 0;
function check(name, ok, extra) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { status: res.status, json };
}

async function main() {
  console.log(`Smoke testing real Wikipedia connector at ${API}\n`);

  // Provider statuses (config-derived, no network)
  const prov = await req("GET", `${API}/providers`);
  const providers = prov.json?.data ?? [];
  check("GET providers -> 200", prov.status === 200);
  const wiki = providers.find((p) => p.name === "WIKIPEDIA");
  const google = providers.find((p) => p.name === "GOOGLE");
  const yandex = providers.find((p) => p.name === "YANDEX");
  check("wikipedia provider present", !!wiki, wiki?.status);
  check("google NOT enabled (DISABLED/NOT_CONFIGURED)", google && google.status !== "ENABLED", google?.status);
  check("yandex NOT enabled (DISABLED/NOT_CONFIGURED)", yandex && yandex.status !== "ENABLED", yandex?.status);

  // Case with a well-known subject so a real page is likely found
  const c = await req("POST", `${API}/cases`, {
    fullName: "Linus Torvalds",
    aliases: [],
    targetRegions: ["GLOBAL"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = c.json?.data?.id;
  check("setup: case created", c.status === 201 && !!caseId);
  if (!caseId) process.exit(1);

  // real-wikipedia must be present in the agents list, kind REAL
  const agents = await req("GET", `${API}/cases/${caseId}/agents`);
  const real = (agents.json?.data ?? []).find((a) => a.name === "REAL_WIKIPEDIA");
  check("real-wikipedia agent present", !!real);
  check("real-wikipedia kind = REAL", real?.kind === "REAL", real?.kind);

  if (wiki?.status !== "ENABLED") {
    // Disabled path: run should report a clean error, not crash.
    const run = await req("POST", `${API}/cases/${caseId}/agents/REAL_WIKIPEDIA/run`);
    check("disabled run -> 201 with FAILED status", run.status === 201 && run.json?.data?.status === "FAILED");
    check("disabled run has clear error", typeof run.json?.data?.error === "string");
    console.log("\n(Wikipedia disabled — skipped live checks)");
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }

  // Enabled path: run the real agent
  const run = await req("POST", `${API}/cases/${caseId}/agents/REAL_WIKIPEDIA/run`);
  check("run -> 201", run.status === 201);
  const status = run.json?.data?.status;
  const networkOk = status === "SUCCEEDED";
  check("run completed (SUCCEEDED or graceful FAILED)", status === "SUCCEEDED" || status === "FAILED", status);

  if (!networkOk) {
    check("graceful failure has error message", typeof run.json?.data?.error === "string", run.json?.data?.error);
    console.log("\n(Network to wikipedia.org unavailable — verified graceful failure only)");
    console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
    process.exit(failures === 0 ? 0 : 1);
  }

  // Evidence written
  const ev1 = await req("GET", `${API}/cases/${caseId}/evidence`);
  const realChecks1 = (ev1.json?.data?.wikipediaChecks ?? []).filter((w) =>
    (w.checkedBy ?? "").startsWith("real")
  );
  check("real wikipedia_check(s) written", realChecks1.length >= 1, String(realChecks1.length));
  check("real check carries snapshot (demo=false)", realChecks1.every((w) => w.snapshot && w.snapshot.demo === false));

  // Idempotency: re-run must not duplicate
  await req("POST", `${API}/cases/${caseId}/agents/REAL_WIKIPEDIA/run`);
  const ev2 = await req("GET", `${API}/cases/${caseId}/evidence`);
  const realChecks2 = (ev2.json?.data?.wikipediaChecks ?? []).filter((w) =>
    (w.checkedBy ?? "").startsWith("real")
  );
  check("idempotent: re-run did not duplicate", realChecks2.length === realChecks1.length, `${realChecks1.length} -> ${realChecks2.length}`);

  // Mock audit still works alongside real checks
  const audit = await req("POST", `${API}/cases/${caseId}/audit/run`);
  check("mock full audit still works", audit.status === 201 && audit.json?.data?.outcome === "SUCCESS", audit.json?.data?.outcome);
  const ev3 = await req("GET", `${API}/cases/${caseId}/evidence`);
  const realChecks3 = (ev3.json?.data?.wikipediaChecks ?? []).filter((w) => (w.checkedBy ?? "").startsWith("real"));
  const mockChecks3 = (ev3.json?.data?.wikipediaChecks ?? []).filter((w) => (w.checkedBy ?? "").startsWith("mock"));
  check("mock audit did not clobber real checks", realChecks3.length === realChecks1.length);
  check("mock wikipedia check present too", mockChecks3.length >= 1, String(mockChecks3.length));

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
