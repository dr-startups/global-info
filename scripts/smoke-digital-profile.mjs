/**
 * Smoke test for the Digital Profile Case CRUD API (Stage B).
 *
 * Prerequisites:
 *   1. DIGITAL_PROFILE_ENABLED="true" in .env
 *   2. Database migrated (npm run db:migrate)
 *   3. Dev server running (npm run dev)
 *
 * Run:  node scripts/smoke-digital-profile.mjs
 * Env:  BASE_URL (default http://localhost:3000)
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const BASE = `${BASE_URL}/api/digital-profile/cases`;
const HEADERS = { "content-type": "application/json", "x-actor-id": "smoke-test" };

let failures = 0;

function check(name, condition, extra) {
  const status = condition ? "PASS" : "FAIL";
  if (!condition) failures++;
  console.log(`[${status}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  return { status: res.status, json };
}

async function main() {
  console.log(`Smoke testing ${BASE}\n`);

  // 1. Create
  const create = await req("POST", BASE, {
    fullName: "Smoke Test Subject",
    aliases: ["S. Test"],
    birthDate: "1990-01-01",
    targetRegions: ["EU", "UK"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
    notes: "Created by smoke test.",
  });
  check("POST create -> 201", create.status === 201, `status ${create.status}`);
  check("create returns ok+data", create.json?.ok === true && !!create.json?.data?.id);
  const caseId = create.json?.data?.id;
  if (!caseId) {
    console.error("\nNo case id returned — aborting.");
    process.exit(1);
  }
  console.log(`   created caseId=${caseId} caseNumber=${create.json.data.caseNumber}\n`);

  // 2. List
  const list = await req("GET", `${BASE}?page=1&pageSize=10`);
  check("GET list -> 200", list.status === 200, `status ${list.status}`);
  check(
    "list contains created case",
    Array.isArray(list.json?.data?.items) &&
      list.json.data.items.some((c) => c.id === caseId)
  );

  // 3. Get one
  const getOne = await req("GET", `${BASE}/${caseId}`);
  check("GET one -> 200", getOne.status === 200, `status ${getOne.status}`);
  check(
    "get one returns subject",
    getOne.json?.data?.subject?.fullName === "Smoke Test Subject"
  );

  // 4. Update
  const update = await req("PATCH", `${BASE}/${caseId}`, {
    status: "COLLECTING",
    notes: "Updated by smoke test.",
  });
  check("PATCH update -> 200", update.status === 200, `status ${update.status}`);
  check("update applied", update.json?.data?.status === "COLLECTING");

  // 5. Soft delete
  const del = await req("DELETE", `${BASE}/${caseId}`);
  check("DELETE -> 200", del.status === 200, `status ${del.status}`);
  check("soft delete set deletedAt", !!del.json?.data?.deletedAt);

  // 6. Deleted case is hidden from default get
  const getDeleted = await req("GET", `${BASE}/${caseId}`);
  check("GET deleted -> 404", getDeleted.status === 404, `status ${getDeleted.status}`);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
