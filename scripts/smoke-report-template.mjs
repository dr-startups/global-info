/**
 * Smoke test for ORION-like report template v1 (Stage K1).
 *
 * Prerequisites:
 *   1. DIGITAL_PROFILE_ENABLED="true" in .env
 *   2. Renderer running: docker compose up -d --build renderer  (port 8080)
 *   3. Dev server running (npm run dev)
 *
 * Run:  npm run smoke:report-template
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const RENDERER_URL = process.env.RENDERER_URL ?? "http://localhost:8080";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-template" };

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

async function downloadSig(path, n) {
  const r = await fetch(`${BASE_URL}${path}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, sig: buf.slice(0, n).toString(), size: buf.length };
}

async function newCase(name) {
  const c = await req("POST", `${API}/cases`, {
    fullName: name,
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  return c.json?.data?.id;
}

async function main() {
  console.log(`Smoke testing report template v1 via ${API}\n`);

  try {
    const h = await fetch(`${RENDERER_URL}/health`);
    check("renderer /health ok", h.status === 200);
  } catch (e) {
    check("renderer /health ok", false, e.message);
    console.error("\nRenderer not reachable — start it: docker compose up -d --build renderer");
    process.exit(1);
  }

  // --- Case with rich evidence ---
  const caseId = await newCase("Template Test Person");
  check("setup: case created", !!caseId);
  if (!caseId) process.exit(1);

  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "YANDEX",
    url: "https://news.example/ru/skandal",
    title: "Шаблон Тест — расследование и скандал, мошенничество",
    classification: "ADVERSE_MEDIA",
  });
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://corp.example/profile",
    title: "Template Test Person — corporate profile " + "x".repeat(400),
    classification: "CORPORATE",
  });
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, { type: "SUGGESTION", query: "template test fraud" });
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "IMAGE_RESULT", title: "img", url: "https://img.example/1", classification: "NEGATIVE",
  });
  await req("POST", `${API}/cases/${caseId}/wikipedia-checks`, { exists: false, language: "en" });
  await req("POST", `${API}/cases/${caseId}/database-profiles`, {
    provider: "WORLD_CHECK", importMethod: "MANUAL_IMPORT", matchType: "SANCTIONS", matchScore: 95,
    evidenceRefs: [{ type: "DATABASE_RECORD", label: "WC sanctions" }],
  });
  await req("POST", `${API}/cases/${caseId}/risk/classify`);

  // --- Generate + render with template v1 ---
  const gen = await req("POST", `${API}/cases/${caseId}/report/generate`);
  check("report generated", gen.status === 201);
  const rep = gen.json?.data;
  const offer = rep?.reportJson?.offer;
  check("report_json contains offer block", !!offer);
  check("offer prices come from config (>0)", (offer?.solution1Price ?? 0) > 0, String(offer?.solution1Price));
  check("report_json contains auditSummary", !!rep?.reportJson?.auditSummary);

  const render = await req("POST", `${API}/cases/${caseId}/report/render`, { templateVersion: "report-template-v1" });
  const r = render.json?.data;
  check("render v1 -> 201", render.status === 201, `status ${render.status}`);
  check("render used template v1", r?.templateVersion === "report-template-v1", r?.templateVersion);
  check("render returns warnings array", Array.isArray(r?.warnings));
  check("render returns pptx + pdf urls", !!r?.pptxDownloadUrl && !!r?.pdfDownloadUrl);

  if (r?.pdfDownloadUrl) {
    const pdf = await downloadSig(r.pdfDownloadUrl, 5);
    check("v1 pdf has %PDF signature", pdf.status === 200 && pdf.sig === "%PDF-", `size ${pdf.size}`);
  }
  if (r?.pptxDownloadUrl) {
    const pptx = await downloadSig(r.pptxDownloadUrl, 2);
    check("v1 pptx has PK (zip) signature", pptx.status === 200 && pptx.sig === "PK", `size ${pptx.size}`);
  }

  // --- Fallback: simple renderer ---
  const renderSimple = await req("POST", `${API}/cases/${caseId}/report/render`, { templateVersion: "simple" });
  const rs = renderSimple.json?.data;
  check("render simple -> 201", renderSimple.status === 201);
  check("render used simple template", rs?.templateVersion === "simple", rs?.templateVersion);
  if (rs?.pptxDownloadUrl) {
    const pptx = await downloadSig(rs.pptxDownloadUrl, 2);
    check("simple pptx has PK signature", pptx.status === 200 && pptx.sig === "PK", `size ${pptx.size}`);
  }

  // --- Empty case must not crash and should warn ---
  const emptyId = await newCase("Empty Template Case");
  await req("POST", `${API}/cases/${emptyId}/report/generate`);
  const renderEmpty = await req("POST", `${API}/cases/${emptyId}/report/render`, { templateVersion: "report-template-v1" });
  const re = renderEmpty.json?.data;
  check("empty case render -> 201 (no crash)", renderEmpty.status === 201, `status ${renderEmpty.status}`);
  check("empty case renderer warnings present", (re?.warnings?.length ?? 0) >= 1, `warnings ${re?.warnings?.length}`);
  if (re?.pdfDownloadUrl) {
    const pdf = await downloadSig(re.pdfDownloadUrl, 5);
    check("empty case pdf has %PDF signature", pdf.status === 200 && pdf.sig === "%PDF-", `size ${pdf.size}`);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
