/**
 * Smoke test for Digital Profile manual evidence input (Stage C).
 *
 * Prerequisites:
 *   1. DIGITAL_PROFILE_ENABLED="true" in .env
 *   2. Database migrated (npm run db:migrate)
 *   3. Dev server running (npm run dev)
 *
 * Run:  node scripts/smoke-evidence.mjs
 * Env:  BASE_URL (default http://localhost:3000)
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const JSON_HEADERS = {
  "content-type": "application/json",
  "x-actor-id": "smoke-evidence",
};

let failures = 0;
function check(name, ok, extra) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function req(method, url, body, headers = JSON_HEADERS) {
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* binary or empty */
  }
  return { res, status: res.status, json };
}

async function main() {
  console.log(`Smoke testing evidence API at ${API}\n`);

  // Setup: create a case
  const create = await req("POST", `${API}/cases`, {
    fullName: "Evidence Test Subject",
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = create.json?.data?.id;
  check("setup: case created", create.status === 201 && !!caseId);
  if (!caseId) process.exit(1);
  console.log(`   caseId=${caseId}\n`);

  // 1. Search query
  const query = await req("POST", `${API}/cases/${caseId}/search-queries`, {
    engine: "GOOGLE",
    queryText: '"Evidence Test Subject"',
  });
  check("search query added", query.status === 201 && !!query.json?.data?.id);

  // 2. Search result + dedup
  const r1 = await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://example.com/a?utm_source=x#frag",
    title: "Result A",
    queryId: query.json?.data?.id,
  });
  check("search result created", r1.status === 201 && r1.json?.data?.deduplicated === false);
  const resultId = r1.json?.data?.result?.id;

  const r2 = await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://example.com/a/", // same after normalization
  });
  check("duplicate URL deduplicated", r2.status === 200 && r2.json?.data?.deduplicated === true);

  // 3. Classify result
  const cls = await req("PATCH", `${API}/search-results/${resultId}`, {
    classification: "CORPORATE",
    reviewStatus: "REVIEWED",
  });
  check("result classified", cls.status === 200 && cls.json?.data?.classification === "CORPORATE");

  // 4. Screenshot upload (1x1 PNG)
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const form = new FormData();
  form.append(
    "file",
    new Blob([Buffer.from(pngBase64, "base64")], { type: "image/png" }),
    "shot.png"
  );
  form.append("sourceUrl", "https://example.com/a");
  form.append("resultId", resultId);
  const upRes = await fetch(`${API}/cases/${caseId}/screenshots`, {
    method: "POST",
    headers: { "x-actor-id": "smoke-evidence" },
    body: form,
  });
  const upJson = await upRes.json().catch(() => null);
  check("screenshot uploaded", upRes.status === 201 && !!upJson?.data?.id);
  const shot = upJson?.data;
  check("screenshot has sha256 + signed url", !!shot?.sha256 && !!shot?.downloadUrl);

  // 5. Signed download works
  if (shot?.downloadUrl) {
    const dl = await fetch(`${BASE_URL}${shot.downloadUrl}`);
    check("signed download -> 200 image", dl.status === 200 && (dl.headers.get("content-type") || "").startsWith("image/"));
    // tampered token -> 404
    const bad = await fetch(`${BASE_URL}${shot.downloadUrl}tampered`);
    check("tampered token -> 404", bad.status === 404);
  }

  // 6. Database profile (manual import, evidence-first)
  const db = await req("POST", `${API}/cases/${caseId}/database-profiles`, {
    provider: "WORLD_CHECK",
    importMethod: "MANUAL_IMPORT",
    matchType: "no-match",
    evidenceRefs: [{ type: "IMPORTED_FILE", label: "manual export" }],
  });
  check("database profile imported", db.status === 201 && !!db.json?.data?.id);

  // 6b. Evidence-first guard: finding without evidence is rejected
  const badFinding = await req("POST", `${API}/cases/${caseId}/risk-findings`, {
    category: "Test",
    title: "No evidence",
    evidenceRefs: [],
  });
  check("finding without evidence -> 400", badFinding.status === 400);

  // 7. Wikipedia check
  const wiki = await req("POST", `${API}/cases/${caseId}/wikipedia-checks`, {
    exists: false,
    language: "en",
  });
  check("wikipedia check added", wiki.status === 201 && !!wiki.json?.data?.id);

  // 8. Risk finding (with evidence) + review
  const finding = await req("POST", `${API}/cases/${caseId}/risk-findings`, {
    category: "Corporate affiliation",
    severity: "LOW",
    title: "Listed as director",
    evidenceRefs: [{ type: "URL", refId: resultId, url: "https://example.com/a", label: "Result A" }],
  });
  check("risk finding created (PENDING)", finding.status === 201 && finding.json?.data?.reviewStatus === "PENDING");
  const findingId = finding.json?.data?.id;

  const review = await req("POST", `${API}/findings/${findingId}/review`, {
    reviewStatus: "REVIEWED",
    reviewedBy: "analyst",
  });
  check("finding reviewed", review.status === 200 && review.json?.data?.reviewStatus === "REVIEWED");

  // 9. Aggregate evidence
  const agg = await req("GET", `${API}/cases/${caseId}/evidence`);
  const d = agg.json?.data;
  check(
    "aggregate evidence complete",
    agg.status === 200 &&
      d?.searchQueries?.length >= 1 &&
      d?.searchResults?.length >= 1 &&
      d?.screenshots?.length >= 1 &&
      d?.databaseProfiles?.length >= 1 &&
      d?.wikipediaChecks?.length >= 1 &&
      d?.riskFindings?.length >= 1
  );

  // 10. Admin guard on screenshot delete
  if (shot?.id) {
    const noAdmin = await req("DELETE", `${API}/screenshots/${shot.id}`);
    check("delete without admin -> 403", noAdmin.status === 403);
    const asAdmin = await req("DELETE", `${API}/screenshots/${shot.id}`, undefined, {
      "x-actor-id": "smoke-evidence",
      "x-actor-role": "admin",
    });
    check("delete as admin -> 200 soft delete", asAdmin.status === 200 && !!asAdmin.json?.data?.deletedAt);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
