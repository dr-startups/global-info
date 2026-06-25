/**
 * Smoke test for polished report template v3 + final commercial block (Stage K3).
 *
 * Prerequisites:
 *   1. DIGITAL_PROFILE_ENABLED="true" in .env
 *   2. Renderer running: docker compose up -d --build renderer  (port 8080)
 *   3. Dev server running (npm run dev)
 *
 * Run:  npm run smoke:report-template-v3
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const RENDERER_URL = process.env.RENDERER_URL ?? "http://localhost:8080";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-template-v3" };

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

const MIN_SLIDES = 45; // v3 builds ~50 slides; allow headroom.

async function main() {
  console.log(`Smoke testing report template v3 via ${API}\n`);

  try {
    const h = await fetch(`${RENDERER_URL}/health`);
    check("renderer /health ok", h.status === 200);
  } catch (e) {
    check("renderer /health ok", false, e.message);
    console.error("\nRenderer not reachable — start it: docker compose up -d --build renderer");
    process.exit(1);
  }

  // --- Rich case ---
  const caseId = await newCase("Template V3 Person");
  check("setup: case created", !!caseId);
  if (!caseId) process.exit(1);

  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "YANDEX",
    url: "https://news.example/ru/rassledovanie",
    title: "Шаблон V3 — расследование, скандал и мошенничество " + "д".repeat(280),
    classification: "ADVERSE_MEDIA",
  });
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://corp.example/en/profile",
    title: "Template V3 Person — corporate profile " + "x".repeat(300),
    classification: "CORPORATE",
  });
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, { type: "SUGGESTION", query: "шаблон v3 мошенничество" });
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, { type: "RELATED_QUERY", query: "шаблон v3 суд" });
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "IMAGE_RESULT", title: "негатив", url: "https://img.example/ru/1", classification: "NEGATIVE",
  });
  await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "KNOWLEDGE_BLOCK", title: "Шаблон V3", snippet: "described entity", source: "https://kb.example",
  });
  await req("POST", `${API}/cases/${caseId}/wikipedia-checks`, { exists: false, language: "ru" });
  await req("POST", `${API}/cases/${caseId}/database-profiles`, {
    provider: "WORLD_CHECK", importMethod: "MANUAL_IMPORT", matchType: "SANCTIONS", matchScore: 95,
    evidenceRefs: [{ type: "DATABASE_RECORD", label: "WC sanctions" }],
  });
  await req("POST", `${API}/cases/${caseId}/risk/classify`);

  const gen = await req("POST", `${API}/cases/${caseId}/report/generate`);
  check("report generated", gen.status === 201);
  const offer = gen.json?.data?.reportJson?.offer;
  check("offer prices come from config (>0)", (offer?.solution1Price ?? 0) > 0, String(offer?.solution1Price));
  check("offer has structured solutions[]", Array.isArray(offer?.solutions) && offer.solutions.length >= 3);
  check("offer solution carries deliverables", Array.isArray(offer?.solutions?.[0]?.deliverables));
  check("offer has processSteps + disclaimers", Array.isArray(offer?.processSteps) && Array.isArray(offer?.disclaimers));

  // --- Render v3 (internal + draft default) ---
  const render = await req("POST", `${API}/cases/${caseId}/report/render`, { templateVersion: "report-template-v3" });
  const r = render.json?.data;
  check("render v3 -> 201", render.status === 201, `status ${render.status}`);
  check("render used template v3", r?.templateVersion === "report-template-v3", r?.templateVersion);
  check(`slideCount >= ${MIN_SLIDES}`, (r?.slideCount ?? 0) >= MIN_SLIDES, `slides ${r?.slideCount}`);
  check("render returns warnings array", Array.isArray(r?.warnings));
  check("render reports audience=internal (default)", r?.audience === "internal", r?.audience);
  check("render reports watermarkMode=draft (default)", r?.watermarkMode === "draft", r?.watermarkMode);

  if (r?.pdfDownloadUrl) {
    const pdf = await downloadSig(r.pdfDownloadUrl, 5);
    check("v3 pdf has %PDF signature", pdf.status === 200 && pdf.sig === "%PDF-", `size ${pdf.size}`);
  }
  if (r?.pptxDownloadUrl) {
    const pptx = await downloadSig(r.pptxDownloadUrl, 2);
    check("v3 pptx has PK (zip) signature", pptx.status === 200 && pptx.sig === "PK", `size ${pptx.size}`);
  }

  // --- audience=client ---
  const rClient = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3", audience: "client",
  });
  check("render audience=client -> 201", rClient.status === 201);
  check("audience=client echoed", rClient.json?.data?.audience === "client", rClient.json?.data?.audience);

  // --- watermark none ---
  const rNoWm = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3", watermarkMode: "none",
  });
  check("render watermark=none -> 201", rNoWm.status === 201);
  check("watermarkMode=none echoed", rNoWm.json?.data?.watermarkMode === "none", rNoWm.json?.data?.watermarkMode);

  // --- v2 + v1 + simple regression ---
  const rv2 = await req("POST", `${API}/cases/${caseId}/report/render`, { templateVersion: "report-template-v2" });
  check("render v2 still works", rv2.status === 201 && rv2.json?.data?.templateVersion === "report-template-v2");
  const rv1 = await req("POST", `${API}/cases/${caseId}/report/render`, { templateVersion: "report-template-v1" });
  check("render v1 still works", rv1.status === 201 && rv1.json?.data?.templateVersion === "report-template-v1");
  const rsimple = await req("POST", `${API}/cases/${caseId}/report/render`, { templateVersion: "simple" });
  check("render simple still works", rsimple.status === 201 && rsimple.json?.data?.templateVersion === "simple");

  // --- Empty / no-data case must not crash; still polished slide count; warns ---
  const emptyId = await newCase("Empty V3 Case");
  await req("POST", `${API}/cases/${emptyId}/report/generate`);
  const renderEmpty = await req("POST", `${API}/cases/${emptyId}/report/render`, { templateVersion: "report-template-v3" });
  const re = renderEmpty.json?.data;
  check("empty case render -> 201 (no crash)", renderEmpty.status === 201, `status ${renderEmpty.status}`);
  check(`empty case still >= ${MIN_SLIDES} slides`, (re?.slideCount ?? 0) >= MIN_SLIDES, `slides ${re?.slideCount}`);
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
