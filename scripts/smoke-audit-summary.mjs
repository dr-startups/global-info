/**
 * Smoke test for the Audit Summary builder (Stage J). No API keys required.
 *
 * Verifies deterministic aggregation, cautious summaries, dismissed-finding
 * exclusion and report_json.auditSummary integration.
 *
 * Prerequisites: DIGITAL_PROFILE_ENABLED=true, dev server running.
 * Run:  npm run smoke:audit-summary
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-audit" };

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

const RANK = { UNKNOWN: -1, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

async function summary(caseId) {
  const r = await req("GET", `${API}/cases/${caseId}/audit-summary`);
  return r.json?.data?.auditSummary;
}

async function main() {
  console.log(`Smoke testing Audit Summary builder at ${API}\n`);

  // --- Empty case ---
  const empty = await req("POST", `${API}/cases`, {
    fullName: "Empty Audit Case",
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const emptyId = empty.json?.data?.id;
  check("setup: empty case", empty.status === 201 && !!emptyId);
  const es = await summary(emptyId);
  check("empty case summary builds", !!es);
  check("empty case overall UNKNOWN", es?.overallRiskLevel === "UNKNOWN", es?.overallRiskLevel);
  check("empty case has data-quality warnings", (es?.dataQualitySummary?.warnings?.length ?? 0) > 0);

  // --- Seeded case ---
  const c = await req("POST", `${API}/cases`, {
    fullName: "Audit Test Person",
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = c.json?.data?.id;
  check("setup: case created", c.status === 201 && !!caseId);
  if (!caseId) process.exit(1);

  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://news.example/story-a",
    title: "Audit Test Person fraud scandal investigation",
    classification: "ADVERSE_MEDIA",
  });
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://corp.example/profile",
    title: "Audit Test Person — company profile",
    classification: "CORPORATE",
  });
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "SUGGESTION",
    query: "audit test person fraud",
  });
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "IMAGE_RESULT",
    title: "img",
    url: "https://img.example/a",
    classification: "NEGATIVE",
  });
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "VIDEO_RESULT",
    title: "vid",
    videoUrl: "https://v.example/a",
    classification: "NEGATIVE",
  });
  await req("POST", `${API}/cases/${caseId}/wikipedia-checks`, { exists: false, language: "en" });
  await req("POST", `${API}/cases/${caseId}/database-profiles`, {
    provider: "DOW_JONES",
    importMethod: "MANUAL_IMPORT",
    matchType: "PEP",
    matchScore: 80,
    evidenceRefs: [{ type: "DATABASE_RECORD", label: "Dow Jones PEP" }],
  });
  await req("POST", `${API}/cases/${caseId}/database-profiles`, {
    provider: "WORLD_CHECK",
    importMethod: "MANUAL_IMPORT",
    matchType: "SANCTIONS",
    matchScore: 95,
    evidenceRefs: [{ type: "DATABASE_RECORD", label: "World-Check sanctions" }],
  });

  // --- Build via POST ---
  const built = await req("POST", `${API}/cases/${caseId}/audit-summary/build`);
  check("POST build -> 200", built.status === 200);
  const s = built.json?.data?.auditSummary;
  check("audit summary returned", !!s);
  check("search negativeShare computed (>0)", (s?.searchSummary?.negativeShare ?? 0) > 0, String(s?.searchSummary?.negativeShare));
  check("surfaces suggestions counted", s?.surfacesSummary?.suggestions?.total >= 1);
  check("surfaces negative image counted", s?.surfacesSummary?.images?.negative >= 1);
  check("surfaces negative video counted", s?.surfacesSummary?.videos?.negative >= 1);
  check("wikipedia summary exists=false", s?.wikipediaSummary?.exists === false);
  check("compliance PEP match counted", s?.complianceDatabaseSummary?.pepMatches >= 1);
  check("compliance sanctions match counted", s?.complianceDatabaseSummary?.sanctionsMatches >= 1);
  check("overall risk elevated (>=HIGH due to sanctions)", (RANK[s?.overallRiskLevel] ?? -1) >= RANK.HIGH, s?.overallRiskLevel);
  check("executive summary has bullets", (s?.executiveSummary?.length ?? 0) >= 3);
  check("recommended actions present", (s?.recommendedActions?.length ?? 0) >= 1);
  check("two regions present (RU/UAE)", s?.regions?.length === 2);

  // --- Risk findings + dismissed exclusion ---
  await req("POST", `${API}/cases/${caseId}/risk/classify`);
  const beforeDismiss = await summary(caseId);
  const activeBefore = beforeDismiss.riskSummary.totalFindings;
  check("risk findings counted in summary", activeBefore >= 1, String(activeBefore));

  const ev = await req("GET", `${API}/cases/${caseId}/evidence`);
  const fds = ev.json?.data?.riskFindings ?? [];
  const toDismiss = fds.find((f) => f.signalType === "NEGATIVE_SUGGESTION") ?? fds.find((f) => f.signalType);
  check("found a classifier finding to dismiss", !!toDismiss);
  await req("POST", `${API}/findings/${toDismiss.id}/review`, { reviewStatus: "DISMISSED" });

  const afterDismiss = await summary(caseId);
  check(
    "dismissed finding excluded from active count",
    afterDismiss.riskSummary.totalFindings === activeBefore - 1,
    `${activeBefore} -> ${afterDismiss.riskSummary.totalFindings}`
  );
  check(
    "dismissed finding not in topFindings",
    !afterDismiss.riskSummary.topFindings.some((f) => f.title === toDismiss.title)
  );

  // --- report_json carries auditSummary ---
  await req("POST", `${API}/cases/${caseId}/report/generate`);
  const rep = await req("GET", `${API}/cases/${caseId}/report`);
  const auditInReport = rep.json?.data?.reportJson?.auditSummary;
  check("report_json contains auditSummary", !!auditInReport, auditInReport ? `risk=${auditInReport.overallRiskLevel}` : "missing");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
