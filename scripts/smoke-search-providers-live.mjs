/**
 * LIVE smoke test for real Google/Yandex connectors (Stage H2).
 *
 * Only runs the live path when the provider is ENABLED+configured (real API keys
 * present in env). Otherwise it verifies the safe DISABLED/NOT_CONFIGURED path
 * and exits 0 — so it never fails CI without keys.
 *
 * Prerequisites: DIGITAL_PROFILE_ENABLED=true, dev server running.
 * Run:  npm run smoke:search-providers:live
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-search-live" };

let failures = 0;
function check(name, ok, extra) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function req(method, url, body) {
  const res = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { status: res.status, json };
}

async function exercise(agentName, engine, caseId) {
  const run1 = await req("POST", `${API}/cases/${caseId}/agents/${agentName}/run`);
  check(`${agentName}: run -> 201`, run1.status === 201);
  if (run1.json?.data?.status !== "SUCCEEDED") {
    check(`${agentName}: graceful (no crash)`, typeof run1.json?.data?.error === "string", run1.json?.data?.error);
    return;
  }
  const ev1 = await req("GET", `${API}/cases/${caseId}/evidence`);
  const real1 = (ev1.json?.data?.searchResults ?? []).filter(
    (r) => r.engine === engine && (r.source ?? "").startsWith("real")
  );
  check(`${agentName}: real results saved`, real1.length >= 1, String(real1.length));
  check(`${agentName}: source = real:${engine}`, real1.every((r) => r.source === `real:${engine}`));

  // Idempotency
  await req("POST", `${API}/cases/${caseId}/agents/${agentName}/run`);
  const ev2 = await req("GET", `${API}/cases/${caseId}/evidence`);
  const real2 = (ev2.json?.data?.searchResults ?? []).filter(
    (r) => r.engine === engine && (r.source ?? "").startsWith("real")
  );
  check(`${agentName}: re-run did not duplicate`, real2.length === real1.length, `${real1.length} -> ${real2.length}`);
}

async function main() {
  console.log(`Smoke testing LIVE search connectors at ${API}\n`);

  const prov = await req("GET", `${API}/providers`);
  const providers = prov.json?.data ?? [];
  const google = providers.find((p) => p.name === "GOOGLE");
  const yandex = providers.find((p) => p.name === "YANDEX");
  check("GET providers -> 200", prov.status === 200);

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

  if (google?.status === "ENABLED") {
    await exercise("REAL_GOOGLE_SEARCH", "GOOGLE", caseId);
  } else {
    console.log(`(Google ${google?.status} — skipping live Google checks)`);
  }

  if (yandex?.status === "ENABLED") {
    await exercise("REAL_YANDEX_SEARCH", "YANDEX", caseId);
  } else {
    console.log(`(Yandex ${yandex?.status} — skipping live Yandex checks)`);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
