/**
 * Smoke test for the report renderer (Stage E).
 *
 * Prerequisites:
 *   1. DIGITAL_PROFILE_ENABLED="true" in .env
 *   2. Database migrated (npm run db:migrate)
 *   3. Renderer running: docker compose up -d --build renderer  (port 8080)
 *   4. Dev server running (npm run dev)
 *
 * Run:  node scripts/smoke-render.mjs
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const RENDERER_URL = process.env.RENDERER_URL ?? "http://localhost:8080";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-render" };

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
  console.log(`Smoke testing renderer via ${API}\n`);

  // Renderer health
  try {
    const h = await fetch(`${RENDERER_URL}/health`);
    check("renderer /health ok", h.status === 200);
  } catch (e) {
    check("renderer /health ok", false, e.message);
    console.error("\nRenderer not reachable — start it: docker compose up -d --build renderer");
    process.exit(1);
  }

  // Setup case + evidence + report
  const c = await req("POST", `${API}/cases`, {
    fullName: "Render Test Subject",
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = c.json?.data?.id;
  check("setup: case created", c.status === 201 && !!caseId);
  if (!caseId) process.exit(1);

  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://example.com/render-subject",
    title: "Profile",
    classification: "CORPORATE",
  });
  const f = await req("POST", `${API}/cases/${caseId}/risk-findings`, {
    category: "Corporate",
    severity: "LOW",
    title: "Director",
    evidenceRefs: [{ type: "URL", url: "https://example.com/render-subject" }],
  });
  await req("POST", `${API}/findings/${f.json?.data?.id}/review`, { reviewStatus: "REVIEWED" });

  const gen = await req("POST", `${API}/cases/${caseId}/report/generate`);
  check("setup: report generated", gen.status === 201 && !!gen.json?.data?.id);

  // Render
  const render = await req("POST", `${API}/cases/${caseId}/report/render`);
  const r = render.json?.data;
  check("render -> 201", render.status === 201, `status ${render.status}`);
  check("render returns rend, timestamp", !!r?.renderedAt);
  check("render returns pptx + pdf download urls", !!r?.pptxDownloadUrl && !!r?.pdfDownloadUrl);

  // Download PDF
  if (r?.pdfDownloadUrl) {
    const pdf = await fetch(`${BASE_URL}${r.pdfDownloadUrl}`);
    const ct = pdf.headers.get("content-type") || "";
    const buf = Buffer.from(await pdf.arrayBuffer());
    check("pdf download -> 200 application/pdf", pdf.status === 200 && ct.includes("application/pdf"));
    check("pdf has %PDF signature", buf.slice(0, 5).toString() === "%PDF-", `size ${buf.length}`);
    const bad = await fetch(`${BASE_URL}${r.pdfDownloadUrl}TAMPERED`);
    check("tampered pdf token -> 404", bad.status === 404);
  }

  // Download PPTX
  if (r?.pptxDownloadUrl) {
    const pptx = await fetch(`${BASE_URL}${r.pptxDownloadUrl}`);
    const buf = Buffer.from(await pptx.arrayBuffer());
    // PPTX is a zip: starts with PK\x03\x04
    check("pptx download -> 200 zip(PK)", pptx.status === 200 && buf.slice(0, 2).toString() === "PK", `size ${buf.length}`);
  }

  // GET report reflects rendered artifacts
  const get = await req("GET", `${API}/cases/${caseId}/report`);
  check("GET report exposes pdf url", get.status === 200 && !!get.json?.data?.pdfDownloadUrl);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
