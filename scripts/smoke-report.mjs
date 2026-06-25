/**
 * Smoke test for the report_json builder (Stage D).
 *
 * Prerequisites:
 *   1. DIGITAL_PROFILE_ENABLED="true" in .env
 *   2. Database migrated (npm run db:migrate)
 *   3. Dev server running (npm run dev)
 *
 * Run:  node scripts/smoke-report.mjs
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-report" };

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
  console.log(`Smoke testing report builder at ${API}\n`);

  // Setup case
  const c = await req("POST", `${API}/cases`, {
    fullName: "Report Test Subject",
    aliases: ["R. Test"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = c.json?.data?.id;
  check("setup: case created", c.status === 201 && !!caseId);
  if (!caseId) process.exit(1);

  // Evidence: relevant search result
  const r = await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://example.com/report-subject",
    title: "Director profile",
    classification: "CORPORATE",
  });
  const resultId = r.json?.data?.result?.id;
  check("setup: search result added", r.status === 201 && !!resultId);

  // Reviewed finding (should appear)
  const f1 = await req("POST", `${API}/cases/${caseId}/risk-findings`, {
    category: "Corporate",
    severity: "MEDIUM",
    title: "Director of Example Ltd",
    evidenceRefs: [{ type: "URL", refId: resultId, url: "https://example.com/report-subject" }],
  });
  const f1id = f1.json?.data?.id;
  await req("POST", `${API}/findings/${f1id}/review`, { reviewStatus: "REVIEWED" });
  check("setup: reviewed finding", f1.status === 201 && !!f1id);

  // Pending finding (should NOT appear)
  const f2 = await req("POST", `${API}/cases/${caseId}/risk-findings`, {
    category: "Other",
    severity: "HIGH",
    title: "Unreviewed — must be excluded",
    evidenceRefs: [{ type: "URL", url: "https://example.com/x" }],
  });
  check("setup: pending finding", f2.status === 201);

  // Generate report v1
  const gen = await req("POST", `${API}/cases/${caseId}/report/generate`);
  const v1 = gen.json?.data;
  check("generate -> 201 version 1", gen.status === 201 && v1?.version === 1);
  check("report status DRAFT + watermark", v1?.status === "DRAFT" && v1?.watermark === "DRAFT");

  const rj = v1?.reportJson;
  check("report_json has meta + subject", !!rj?.meta?.caseNumber && rj?.subject?.fullName === "Report Test Subject");
  check("meta watermark = DRAFT", rj?.meta?.watermark === "DRAFT");

  const kinds = (rj?.dynamicPages ?? []).map((p) => p.kind);
  check("dynamic pages include core sections",
    ["COVER", "SUMMARY", "SUBJECT", "SEARCH_RESULTS", "RISK_FINDINGS"].every((k) => kinds.includes(k)),
    kinds.join(","));

  const riskPage = (rj?.dynamicPages ?? []).find((p) => p.kind === "RISK_FINDINGS");
  check("only REVIEWED finding included (1 row)", riskPage?.table?.rows?.length === 1);
  check("risk findings page carries evidence", Array.isArray(riskPage?.evidence) && riskPage.evidence.length >= 1);

  const searchPage = (rj?.dynamicPages ?? []).find((p) => p.kind === "SEARCH_RESULTS");
  check("search results page carries evidence (evidence-first)", (searchPage?.evidence?.length ?? 0) >= 1);

  check("static commercial pages present (3)", (rj?.staticPages ?? []).length === 3);
  check("pricing present", (rj?.pricing ?? []).length >= 1);
  check("pptx/pdf not rendered yet", v1?.pptxUrl === null && v1?.pdfUrl === null);

  // GET latest
  const get = await req("GET", `${API}/cases/${caseId}/report`);
  check("GET report -> 200 version 1", get.status === 200 && get.json?.data?.version === 1);

  // Generate again -> v2
  const gen2 = await req("POST", `${API}/cases/${caseId}/report/generate`);
  check("re-generate -> version 2", gen2.status === 201 && gen2.json?.data?.version === 2);

  const getLatest = await req("GET", `${API}/cases/${caseId}/report`);
  check("GET returns latest (version 2)", getLatest.json?.data?.version === 2);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
