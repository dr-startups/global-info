/**
 * Smoke test for Stage R1 — Report Polish / Enterprise Due Diligence Layout.
 *
 * Verifies Template v3 still renders 50 slides with polished compliance pages
 * (32–36), offer block (37–50), SERP page 10, watermarks, and no secrets.
 *
 * Prerequisites:
 *   1. DIGITAL_PROFILE_ENABLED="true" in .env
 *   2. Renderer: docker compose up -d --build renderer (port 8080)
 *   3. Dev server: npm run dev
 *
 * Run: npm run smoke:report-polish-r1
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const RENDERER_URL = process.env.RENDERER_URL ?? "http://localhost:8080";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-r1-polish" };

const SLIDE_COUNT = 50;
const SECRET_RE = /(?:api[_-]?key|secret|password|Bearer\s+[A-Za-z0-9._-]{20,})/i;

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
  return { status: r.status, sig: buf.slice(0, n).toString(), size: buf.length, buf };
}

async function newCase(name) {
  const c = await req("POST", `${API}/cases`, {
    fullName: name,
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  return c.json?.data?.id;
}

function stripMissingConfigKeys(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripMissingConfigKeys);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "missingConfigKeys") continue;
    out[k] = stripMissingConfigKeys(v);
  }
  return out;
}

function scanSecrets(label, text) {
  const ok = !SECRET_RE.test(text);
  check(`${label} has no secret-like tokens`, ok);
  return ok;
}

async function manualImport(caseId, body) {
  return req("POST", `${API}/cases/${caseId}/compliance/manual-import`, body);
}

async function reviewHit(hitId, reviewStatus) {
  return req("PATCH", `${API}/database-profiles/${hitId}/review`, { reviewStatus });
}

async function renderCase(caseId, opts = {}) {
  await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: opts.lang ?? "ru" });
  return req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: opts.audience ?? "internal",
    watermarkMode: opts.watermark ?? "draft",
    reportLanguage: opts.lang ?? "ru",
  });
}

async function main() {
  console.log("Smoke testing R1 report polish via", API, "\n");

  try {
    const h = await fetch(`${RENDERER_URL}/health`);
    check("renderer /health ok", h.status === 200);
  } catch (e) {
    check("renderer /health ok", false, e.message);
    process.exit(1);
  }

  // --- Empty case: no compliance hits ---
  const emptyId = await newCase("R1 Empty Case");
  check("empty case created", !!emptyId);
  const emptyRender = await renderCase(emptyId);
  const emptyData = emptyRender.json?.data;
  check("empty case render -> 201", emptyRender.status === 201);
  check(`empty case slideCount === ${SLIDE_COUNT}`, emptyData?.slideCount === SLIDE_COUNT, String(emptyData?.slideCount));
  check("empty case warnings array", Array.isArray(emptyData?.warnings));

  // --- Manual compliance hit (pending) ---
  const richId = await newCase("R1 Compliance Person " + "X".repeat(120));
  check("rich case created", !!richId);

  await req("POST", `${API}/cases/${richId}/search-results`, {
    engine: "YANDEX",
    url: "https://news.example/r1/profile",
    title: "R1 report polish adverse media " + "z".repeat(200),
    classification: "ADVERSE_MEDIA",
  });

  const imp1 = await manualImport(richId, {
    provider: "DOW_JONES",
    matchedName: "R1 Compliance Person Very Long Name " + "A".repeat(80),
    profileUrl: "https://example.com/profile/" + "path/".repeat(30),
    riskTypes: ["SANCTIONS", "PEP"],
    matchScore: 72,
    confidence: "HIGH",
  });
  check("manual import pending -> 201", imp1.status === 201, String(imp1.status));
  const hitId = imp1.json?.data?.id;

  const imp2 = await manualImport(richId, {
    provider: "LEXISNEXIS",
    matchedName: "R1 Watchlist Candidate",
    riskTypes: ["WATCHLIST"],
    matchScore: 55,
    confidence: "MEDIUM",
  });
  check("second manual import -> 201", imp2.status === 201);

  const gen = await req("POST", `${API}/cases/${richId}/report/generate`, { reportLanguage: "ru" });
  const reportJson = gen.json?.data?.reportJson;
  check("report generated", gen.status === 201);
  check("complianceSummary present", !!reportJson?.complianceSummary);
  check("complianceSummary.reviewRequiredWarning", !!reportJson?.complianceSummary?.reviewRequiredWarning);
  check("complianceSummary.providerStatuses", Array.isArray(reportJson?.complianceSummary?.providerStatuses));
  check("providerStatuses has manual import", (reportJson?.complianceSummary?.providerStatuses ?? []).some((p) => p.name === "MANUAL_IMPORT"));

  const safeJson = JSON.stringify(stripMissingConfigKeys(reportJson));
  scanSecrets("report_json", safeJson);

  const ruRender = await renderCase(richId, { lang: "ru", audience: "internal", watermark: "draft" });
  const ru = ruRender.json?.data;
  check("RU/Internal/Draft render -> 201", ruRender.status === 201);
  check(`RU slideCount === ${SLIDE_COUNT}`, ru?.slideCount === SLIDE_COUNT, String(ru?.slideCount));
  check("RU template v3", ru?.templateVersion === "report-template-v3", ru?.templateVersion);
  check("RU watermarkMode=draft", ru?.watermarkMode === "draft", ru?.watermarkMode);

  if (ru?.pptxDownloadUrl) {
    const pptx = await downloadSig(ru.pptxDownloadUrl, 2);
    check("RU pptx PK signature", pptx.status === 200 && pptx.sig === "PK", `size ${pptx.size}`);
    scanSecrets("RU pptx path", ru.pptxDownloadUrl);
  }
  if (ru?.pdfDownloadUrl) {
    const pdf = await downloadSig(ru.pdfDownloadUrl, 5);
    check("RU pdf %PDF signature", pdf.status === 200 && pdf.sig === "%PDF-", `size ${pdf.size}`);
  }

  // --- False positive ---
  if (hitId) {
    const fp = await reviewHit(hitId, "FALSE_POSITIVE");
    check("mark false positive -> 200", fp.status === 200, String(fp.status));
  }

  const fpRender = await renderCase(richId, { lang: "ru" });
  check("after false positive render -> 201", fpRender.status === 201);
  const regen = await req("POST", `${API}/cases/${richId}/report/generate`, { reportLanguage: "ru" });
  check("complianceSummary.falsePositives >= 1", (regen.json?.data?.reportJson?.complianceSummary?.falsePositives ?? 0) >= 1);

  // --- Confirmed match on second hit ---
  const hit2Id = imp2.json?.data?.id;
  if (hit2Id) {
    const conf = await reviewHit(hit2Id, "MATCH_CONFIRMED");
    check("mark confirmed -> 200", conf.status === 200, String(conf.status));
  }

  // --- EN / Client / None ---
  const enRender = await renderCase(richId, { lang: "en", audience: "client", watermark: "none" });
  const en = enRender.json?.data;
  check("EN/Client/None render -> 201", enRender.status === 201);
  check(`EN slideCount === ${SLIDE_COUNT}`, en?.slideCount === SLIDE_COUNT, String(en?.slideCount));
  check("EN audience=client", en?.audience === "client", en?.audience);
  check("EN watermarkMode=none", en?.watermarkMode === "none", en?.watermarkMode);

  // --- SERP snapshot page still works ---
  await req("POST", `${API}/cases/${richId}/serp-snapshot/generate`, {});
  const serpRender = await renderCase(richId);
  check("SERP case render after snapshot -> 201", serpRender.status === 201);
  const serpWarn = serpRender.json?.data?.warnings ?? [];
  check("SERP snapshot embedded (no missing warning)", !serpWarn.some((w) => String(w).toLowerCase().includes("serp snapshot is missing")));

  // --- Offer pages still render (prices from config) ---
  const offer = regen.json?.data?.reportJson?.offer ?? reportJson?.offer;
  check("offer prices from config (>0)", (offer?.solution1Price ?? 0) > 0, String(offer?.solution1Price));
  check("offer solutions[] >= 3", Array.isArray(offer?.solutions) && offer.solutions.length >= 3);

  // --- v1/v2/simple regression ---
  const rv2 = await req("POST", `${API}/cases/${richId}/report/render`, { templateVersion: "report-template-v2" });
  check("v2 fallback still works", rv2.status === 201);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
