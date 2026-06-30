/**
 * Smoke test for Stage S1.5 — ORION-style SERP snapshot embedded in the report.
 *
 * Verifies the full flow:
 *   1. A rich case with search_results.
 *   2. A synthetic SERP snapshot is generated.
 *   3. report_json contains serpSnapshot { id, mode, query, storageKey, metadata }.
 *   4. Template v3 renders PPTX (PK) + PDF (%PDF), slideCount === 50.
 *   5. The snapshot is embedded (no "SERP snapshot is missing" warning).
 *   6. EN / client / watermark=none renders without breaking.
 *   7. A case WITHOUT a snapshot still renders (no crash) and surfaces the
 *      "SERP snapshot is missing" renderWarning.
 *
 * Prerequisites:
 *   1. DIGITAL_PROFILE_ENABLED="true" in .env
 *   2. Renderer running: docker compose up -d --build renderer  (port 8080)
 *   3. Dev server running (npm run dev)
 *
 * Run:  npm run smoke:serp-snapshot-report
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const RENDERER_URL = process.env.RENDERER_URL ?? "http://localhost:8080";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-serp-report" };

const SLIDE_COUNT = 50;
const MISSING_MARKER = "serp snapshot is missing";

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

function hasMissingWarning(warnings) {
  return (warnings ?? []).some((w) => String(w).toLowerCase().includes(MISSING_MARKER));
}

async function main() {
  console.log(`Smoke testing SERP-snapshot-in-report via ${API}\n`);

  try {
    const h = await fetch(`${RENDERER_URL}/health`);
    check("renderer /health ok", h.status === 200);
  } catch (e) {
    check("renderer /health ok", false, e.message);
    console.error("\nRenderer not reachable — start it: docker compose up -d --build renderer");
    process.exit(1);
  }

  // --- Rich case with negative search results ---
  const caseId = await newCase("SERP Report Person");
  check("setup: case created", !!caseId);
  if (!caseId) process.exit(1);

  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "YANDEX",
    url: "https://news.example/ru/rassledovanie",
    title: "SERP Report — расследование и мошенничество",
    classification: "ADVERSE_MEDIA",
  });
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "YANDEX",
    url: "https://court.example/ru/delo",
    title: "SERP Report — судебное дело",
    classification: "NEGATIVE",
  });
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://corp.example/en/profile",
    title: "SERP Report Person — corporate profile",
    classification: "CORPORATE",
  });
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://sanctions.example/en/list",
    title: "SERP Report Person — sanctions mention",
    classification: "SANCTIONS",
  });

  // --- 2. Generate the synthetic SERP snapshot ---
  const snap = await req("POST", `${API}/cases/${caseId}/serp-snapshot/generate`, {});
  check("serp snapshot generated -> 201", snap.status === 201, `status ${snap.status}`);
  const s = snap.json?.data?.snapshot;
  check("snapshot mode SYNTHETIC", s?.mode === "SYNTHETIC", s?.mode);
  check("snapshot has storageKey", typeof s?.storageKey === "string" && s.storageKey.includes("/serp-snapshots/"));
  check("snapshot highlightedCount > 0 (rich case)", (s?.highlightedCount ?? 0) > 0, `highlighted ${s?.highlightedCount}`);
  // Stage N1.2 — manual results have no real source -> MOCK_ONLY; default pref prefer_real.
  check("snapshot sourceMode MOCK_ONLY (manual rows)", s?.sourceMode === "MOCK_ONLY", s?.sourceMode);
  check("snapshot sourcePreference defaults to prefer_real", s?.sourcePreference === "prefer_real", s?.sourcePreference);
  check("snapshot perEngine present", !!s?.perEngine?.yandex && !!s?.perEngine?.google);

  // --- 3. report_json carries the serpSnapshot reference ---
  const gen = await req("POST", `${API}/cases/${caseId}/report/generate`);
  check("report generated", gen.status === 201, `status ${gen.status}`);
  const ss = gen.json?.data?.reportJson?.serpSnapshot;
  check("report_json.serpSnapshot present", !!ss);
  check("serpSnapshot.id present", typeof ss?.id === "string" && ss.id.length > 0);
  check("serpSnapshot.mode === SYNTHETIC", ss?.mode === "SYNTHETIC", ss?.mode);
  check("serpSnapshot.query present", typeof ss?.query === "string");
  check("serpSnapshot.storageKey present", typeof ss?.storageKey === "string");
  check("serpSnapshot.metadata.engines is array", Array.isArray(ss?.metadata?.engines));
  check("serpSnapshot.metadata has themeCount/highlightedCount/generatedAt",
    ss?.metadata?.themeCount !== undefined &&
    ss?.metadata?.highlightedCount !== undefined &&
    ss?.metadata?.generatedAt !== undefined);
  check("serpSnapshot does NOT carry imageBase64 in stored report_json", ss?.imageBase64 === undefined);
  // Stage N1.2 — report_json carries sourceMode + per-engine breakdown.
  check("serpSnapshot.metadata.sourceMode present", ss?.metadata?.sourceMode === "MOCK_ONLY", ss?.metadata?.sourceMode);
  check("serpSnapshot.metadata.perEngine present", !!ss?.metadata?.perEngine?.yandex);
  // Stage C1 — complianceSummary present (env key *names* only in missingConfigKeys, never values).
  const rj = gen.json?.data?.reportJson ?? {};
  check("report_json.complianceSummary present", !!rj.complianceSummary);
  check(
    "complianceSummary.reviewRequiredWarning present",
    typeof rj.complianceSummary?.reviewRequiredWarning === "string" &&
      rj.complianceSummary.reviewRequiredWarning.length > 0
  );
  // Stage N1.2 / C1 — no provider secret *values* leak into report_json.
  const forSecretScan = JSON.parse(JSON.stringify(rj));
  if (forSecretScan.complianceSummary?.providerStatuses) {
    for (const p of forSecretScan.complianceSummary.providerStatuses) {
      delete p.missingConfigKeys;
      delete p.notes;
    }
  }
  const reportStr = JSON.stringify(forSecretScan);
  check(
    "report_json has no secret-like tokens",
    !/api[-_ ]?key|folderId|YANDEX_SEARCH_API_KEY|AIzaSy|"clientSecret"\s*:\s*"[^"]{8,}"/i.test(reportStr)
  );

  // --- 4/5. Render v3 RU / internal / draft — image embedded, 50 slides ---
  const render = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    reportLanguage: "ru",
    audience: "internal",
    watermarkMode: "draft",
  });
  const r = render.json?.data;
  check("render v3 RU draft -> 201", render.status === 201, `status ${render.status}`);
  check("render used template v3", r?.templateVersion === "report-template-v3", r?.templateVersion);
  check(`slideCount === ${SLIDE_COUNT}`, (r?.slideCount ?? 0) === SLIDE_COUNT, `slides ${r?.slideCount}`);
  check("RU draft watermarkMode=draft echoed", r?.watermarkMode === "draft", r?.watermarkMode);
  check("snapshot embedded (no missing warning)", !hasMissingWarning(r?.warnings),
    `warnings ${JSON.stringify(r?.warnings ?? [])}`);

  if (r?.pptxDownloadUrl) {
    const pptx = await downloadSig(r.pptxDownloadUrl, 2);
    check("v3 pptx has PK (zip) signature", pptx.status === 200 && pptx.sig === "PK", `size ${pptx.size}`);
  }
  if (r?.pdfDownloadUrl) {
    const pdf = await downloadSig(r.pdfDownloadUrl, 5);
    check("v3 pdf has %PDF signature", pdf.status === 200 && pdf.sig === "%PDF-", `size ${pdf.size}`);
  }

  // --- 6. EN / client / watermark none ---
  const rEn = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    reportLanguage: "en",
    audience: "client",
    watermarkMode: "none",
  });
  const re = rEn.json?.data;
  check("render EN client none -> 201", rEn.status === 201, `status ${rEn.status}`);
  check("EN client audience echoed", re?.audience === "client", re?.audience);
  check("EN watermarkMode=none echoed", re?.watermarkMode === "none", re?.watermarkMode);
  check(`EN slideCount === ${SLIDE_COUNT}`, (re?.slideCount ?? 0) === SLIDE_COUNT, `slides ${re?.slideCount}`);
  check("EN snapshot embedded (no missing warning)", !hasMissingWarning(re?.warnings));

  // --- 7. R1.1.3 — empty case: report build auto-generates SERP snapshot ---
  const noSnapId = await newCase("No Snapshot Case");
  const genNo = await req("POST", `${API}/cases/${noSnapId}/report/generate`);
  check(
    "empty case report auto-creates serpSnapshot",
    !!genNo.json?.data?.reportJson?.serpSnapshot?.id
  );
  const renderNo = await req("POST", `${API}/cases/${noSnapId}/report/render`, {
    templateVersion: "report-template-v3",
  });
  const rn = renderNo.json?.data;
  check("empty case render -> 201 (no crash)", renderNo.status === 201, `status ${renderNo.status}`);
  check(`empty case slideCount === ${SLIDE_COUNT}`, (rn?.slideCount ?? 0) === SLIDE_COUNT, `slides ${rn?.slideCount}`);
  check("empty case snapshot embedded via auto-regen", !hasMissingWarning(rn?.warnings),
    `warnings ${JSON.stringify(rn?.warnings ?? [])}`);
  if (rn?.pdfDownloadUrl) {
    const pdf = await downloadSig(rn.pdfDownloadUrl, 5);
    check("no-snapshot pdf has %PDF signature", pdf.status === 200 && pdf.sig === "%PDF-", `size ${pdf.size}`);
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
