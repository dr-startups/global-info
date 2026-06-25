/**
 * Smoke test for Risk Classifier v1 (Stage I). No API keys required.
 *
 * Verifies deterministic classification over manual evidence, idempotency, and
 * human-review safety (REVIEWED/DISMISSED are never overwritten/recreated).
 *
 * Prerequisites: DIGITAL_PROFILE_ENABLED=true, dev server running.
 * Run:  npm run smoke:risk-classifier
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-risk" };

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

async function findings(caseId) {
  const r = await req("GET", `${API}/cases/${caseId}/evidence`);
  return r.json?.data?.riskFindings ?? [];
}
const hasSignal = (list, sig) => list.some((f) => f.signalType === sig);

async function main() {
  console.log(`Smoke testing Risk Classifier v1 at ${API}\n`);

  // --- Empty case: classifier must not crash ---
  const empty = await req("POST", `${API}/cases`, {
    fullName: "Empty Risk Case",
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const emptyId = empty.json?.data?.id;
  check("setup: empty case", empty.status === 201 && !!emptyId);
  const c0 = await req("POST", `${API}/cases/${emptyId}/risk/classify`);
  check("empty case classify does not fail", c0.status === 200, JSON.stringify(c0.json?.data));
  check("empty case -> 0 findings created", c0.json?.data?.findingsCreated === 0);

  // --- Main case with seeded evidence ---
  const c = await req("POST", `${API}/cases`, {
    fullName: "Risk Test Person",
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = c.json?.data?.id;
  check("setup: case created", c.status === 201 && !!caseId);
  if (!caseId) process.exit(1);

  // Search result with adverse/negative content
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://news.example/story-1",
    title: "Risk Test Person fraud scandal investigation",
    classification: "ADVERSE_MEDIA",
  });
  // Search result with sanctions mention
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://news.example/sanctions-update",
    title: "Company under sanctions list",
  });
  // Negative suggestion
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "SUGGESTION",
    query: "risk test person fraud",
  });
  // Negative image + video
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "IMAGE_RESULT",
    title: "image",
    url: "https://img.example/1",
    classification: "NEGATIVE",
  });
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "VIDEO_RESULT",
    title: "video",
    videoUrl: "https://v.example/1",
    classification: "NEGATIVE",
  });
  // Wikipedia absent
  await req("POST", `${API}/cases/${caseId}/wikipedia-checks`, { exists: false, language: "en" });
  // Compliance DB PEP match
  await req("POST", `${API}/cases/${caseId}/database-profiles`, {
    provider: "DOW_JONES",
    importMethod: "MANUAL_IMPORT",
    matchType: "PEP",
    matchScore: 80,
    evidenceRefs: [{ type: "DATABASE_RECORD", label: "Dow Jones record" }],
  });

  // --- Classify ---
  const run1 = await req("POST", `${API}/cases/${caseId}/risk/classify`);
  check("classify -> 200", run1.status === 200);
  check("classify created findings", (run1.json?.data?.findingsCreated ?? 0) >= 5, String(run1.json?.data?.findingsCreated));

  const list1 = await findings(caseId);
  check("ADVERSE_MEDIA finding created", hasSignal(list1, "ADVERSE_MEDIA"));
  check("SANCTIONS_MENTION finding created", hasSignal(list1, "SANCTIONS_MENTION"));
  check("NEGATIVE_SUGGESTION finding created", hasSignal(list1, "NEGATIVE_SUGGESTION"));
  check("NEGATIVE_IMAGE finding created", hasSignal(list1, "NEGATIVE_IMAGE"));
  check("NEGATIVE_VIDEO finding created", hasSignal(list1, "NEGATIVE_VIDEO"));
  check("WIKIPEDIA_ABSENT finding created", hasSignal(list1, "WIKIPEDIA_ABSENT"));
  check("COMPLIANCE_DATABASE_MATCH finding created", hasSignal(list1, "COMPLIANCE_DATABASE_MATCH"));
  check("findings carry evidence refs", list1.every((f) => Array.isArray(f.evidenceRefs)));
  check("classifier findings are PENDING", list1.filter((f) => f.signalType).every((f) => f.reviewStatus === "PENDING"));

  // --- Idempotency ---
  const total1 = list1.length;
  const run2 = await req("POST", `${API}/cases/${caseId}/risk/classify`);
  check("re-run created 0", run2.json?.data?.findingsCreated === 0, String(run2.json?.data?.findingsCreated));
  const total2 = (await findings(caseId)).length;
  check("re-run did not duplicate findings", total1 === total2, `${total1} -> ${total2}`);

  // --- Review safety: REVIEWED is not overwritten ---
  const list2 = await findings(caseId);
  const toReview = list2.find((f) => f.signalType === "ADVERSE_MEDIA");
  await req("POST", `${API}/findings/${toReview.id}/review`, { reviewStatus: "REVIEWED" });
  const run3 = await req("POST", `${API}/cases/${caseId}/risk/classify`);
  check("re-run reports skippedReviewed", (run3.json?.data?.findingsSkippedReviewed ?? 0) >= 1, String(run3.json?.data?.findingsSkippedReviewed));
  const reviewedAfter = (await findings(caseId)).find((f) => f.id === toReview.id);
  check("REVIEWED finding preserved", reviewedAfter?.reviewStatus === "REVIEWED");

  // --- Dismiss safety: DISMISSED is not recreated ---
  const toDismiss = list2.find((f) => f.signalType === "NEGATIVE_SUGGESTION");
  await req("POST", `${API}/findings/${toDismiss.id}/review`, { reviewStatus: "DISMISSED" });
  const totalBeforeDismissRun = (await findings(caseId)).length;
  const run4 = await req("POST", `${API}/cases/${caseId}/risk/classify`);
  check("re-run reports dismissedIgnored", (run4.json?.data?.findingsDismissedIgnored ?? 0) >= 1, String(run4.json?.data?.findingsDismissedIgnored));
  const afterDismiss = await findings(caseId);
  check("DISMISSED finding not recreated", afterDismiss.length === totalBeforeDismissRun, `${totalBeforeDismissRun} -> ${afterDismiss.length}`);
  check("DISMISSED finding stays dismissed", afterDismiss.find((f) => f.id === toDismiss.id)?.reviewStatus === "DISMISSED");

  // --- Report carries riskSummary (review one more, generate) ---
  await req("POST", `${API}/cases/${caseId}/report/generate`);
  const rep = await req("GET", `${API}/cases/${caseId}/report`);
  const riskSummary = rep.json?.data?.reportJson?.riskSummary;
  check("report_json has riskSummary", !!riskSummary, riskSummary ? `highest=${riskSummary.highestRiskLevel}` : "missing");

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
