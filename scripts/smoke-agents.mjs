/**
 * Smoke test for mock agents + orchestration (Stage G).
 *
 * Prerequisites:
 *   1. DIGITAL_PROFILE_ENABLED="true" in .env
 *   2. Database migrated (npm run db:migrate)
 *   3. Dev server running (npm run dev)
 *
 * Run:  node scripts/smoke-agents.mjs
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-agents" };

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
  console.log(`Smoke testing agents at ${API}\n`);

  const c = await req("POST", `${API}/cases`, {
    fullName: "Agent Test Subject",
    aliases: ["A. Test"],
    targetRegions: ["RU", "UAE"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = c.json?.data?.id;
  check("setup: case created", c.status === 201 && !!caseId);
  if (!caseId) process.exit(1);

  // List agents (6 mock + real-wikipedia; none run yet)
  const agents0 = await req("GET", `${API}/cases/${caseId}/agents`);
  const list0 = agents0.json?.data ?? [];
  const mockCount = list0.filter((a) => a.kind === "MOCK").length;
  check("GET agents -> 6 mock agents", mockCount === 6, String(mockCount));
  check("GET agents -> real-wikipedia present", list0.some((a) => a.name === "REAL_WIKIPEDIA"));
  check("agents have no lastRun yet", list0.every((a) => a.lastRun === null));

  // Run full audit
  const audit = await req("POST", `${API}/cases/${caseId}/audit/run`);
  check("POST audit/run -> 201", audit.status === 201);
  check("audit outcome SUCCESS", audit.json?.data?.outcome === "SUCCESS", audit.json?.data?.outcome);
  check("audit ran 6 agents", audit.json?.data?.runs?.length === 6);
  check("all agent runs SUCCEEDED", (audit.json?.data?.runs ?? []).every((r) => r.status === "SUCCEEDED"));

  // Agent runs history
  const runs = await req("GET", `${API}/cases/${caseId}/agent-runs`);
  check("GET agent-runs -> >=6", (runs.json?.data?.length ?? 0) >= 6, String(runs.json?.data?.length));

  // Evidence populated
  const ev1 = await req("GET", `${API}/cases/${caseId}/evidence`);
  const e1 = ev1.json?.data ?? {};
  const searchCount1 = e1.searchResults?.length ?? 0;
  check("search results populated (>=10)", searchCount1 >= 10, String(searchCount1));
  check("wikipedia check populated (1)", (e1.wikipediaChecks?.length ?? 0) === 1);
  check("ai profiles populated (2)", (e1.aiProfiles?.length ?? 0) === 2);
  check("compliance profiles populated (3)", (e1.databaseProfiles?.length ?? 0) === 3);
  check("risk findings populated (>=1)", (e1.riskFindings?.length ?? 0) >= 1);
  check("risk findings carry evidence refs", (e1.riskFindings ?? []).every((f) => f.evidenceRefs.length >= 1));
  check("data marked demo (snippet [DEMO])", (e1.searchResults ?? []).every((r) => (r.snippet ?? "").includes("[DEMO]")));

  // Idempotency: re-run yandex agent; search results must NOT keep growing
  const single = await req("POST", `${API}/cases/${caseId}/agents/YANDEX_SEARCH/run`);
  check("POST single agent run -> 201 SUCCEEDED", single.status === 201 && single.json?.data?.status === "SUCCEEDED");
  const ev2 = await req("GET", `${API}/cases/${caseId}/evidence`);
  const searchCount2 = ev2.json?.data?.searchResults?.length ?? 0;
  check("dedup: re-run did not duplicate search results", searchCount2 === searchCount1, `${searchCount1} -> ${searchCount2}`);

  // Idempotency: re-run full audit; counts stable for upserted sections
  await req("POST", `${API}/cases/${caseId}/audit/run`);
  const ev3 = await req("GET", `${API}/cases/${caseId}/evidence`);
  const e3 = ev3.json?.data ?? {};
  check("dedup: wikipedia still 1 after re-audit", (e3.wikipediaChecks?.length ?? 0) === 1);
  check("dedup: ai profiles still 2 after re-audit", (e3.aiProfiles?.length ?? 0) === 2);
  check("dedup: compliance still 3 after re-audit", (e3.databaseProfiles?.length ?? 0) === 3);

  // Unknown agent -> validation error
  const bad = await req("POST", `${API}/cases/${caseId}/agents/NOPE/run`);
  check("unknown agent -> 400", bad.status === 400, String(bad.status));

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
