/**
 * Manual QA R1.1 — generate real report artifacts and validate content.
 * Run: node scripts/manual-qa-r11-artifacts.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "manual-qa-r11" };
const OUT = path.join("storage", "digital-profile", "qa-r11-artifacts");

const BAD_PATTERNS = [
  /example\.com/i,
  /\.example\b/i,
  /\[DEMO\]/i,
  /\bmock:YANDEX\b/i,
  /\bmock:GOOGLE\b/i,
];

const CLIENT_BAD = [/\[DEMO\]/i, /\bMOCK\/DEMO\b/i, /\bmock agent\b/i, /api[_-]?key/i, /secret/i];

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

async function download(urlPath, dest) {
  const res = await fetch(`${BASE_URL}${urlPath}`);
  if (!res.ok) throw new Error(`Download failed ${urlPath}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return dest;
}

async function main() {
  console.log("Manual QA R1.1 — generating report artifacts\n");
  fs.mkdirSync(OUT, { recursive: true });

  const c = await req("POST", `${API}/cases`, {
    fullName: "Manual QA R1.1 Subject",
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = c.json?.data?.id;
  check("case created", !!caseId);
  if (!caseId) process.exit(1);

  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "YANDEX",
    url: "https://lenta.ru/manual-qa-r11-real",
    title: "Real adverse coverage Manual QA",
    classification: "ADVERSE_MEDIA",
  });
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "YANDEX",
    url: "https://news.example.com/manual-qa-mock",
    title: "[DEMO] Mock example row",
    classification: "ADVERSE_MEDIA",
  });
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://corp.example.com/manual-qa-google-mock",
    title: "[DEMO] Google mock fixture",
    classification: "NEGATIVE",
  });
  await req("POST", `${API}/cases/${caseId}/agents/COMPLIANCE_DATABASE/run`);
  await req("POST", `${API}/cases/${caseId}/compliance/manual-import`, {
    provider: "DOW_JONES",
    matchedName: "Manual QA R1.1 Subject",
    riskTypes: ["SANCTIONS"],
    matchScore: 68,
    confidence: "MEDIUM",
  });
  await req("POST", `${API}/cases/${caseId}/serp-snapshot/generate`, {});

  const gen = await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "ru" });
  check("report generate", gen.status === 201);
  const reportJson = gen.json?.data?.reportJson;
  fs.writeFileSync(path.join(OUT, "report-json-ru.json"), JSON.stringify(reportJson, null, 2));

  const rawWarnings = reportJson?.meta?.reportWarnings ?? [];
  const warnings = rawWarnings.map((w) => (typeof w === "string" ? w : w?.text)).filter(Boolean);
  check("reportWarnings mention demo exclusion", warnings.some((w) => /demo|mock/i.test(String(w))), JSON.stringify(rawWarnings));

  const ruRender = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "internal",
    watermarkMode: "draft",
    reportLanguage: "ru",
  });
  const ru = ruRender.json?.data;
  check("RU/Internal/Draft render", ruRender.status === 201);
  check("RU template v3", ru?.templateVersion === "report-template-v3");
  check("RU 50 slides", ru?.slideCount === 50, String(ru?.slideCount));

  const ruPptx = path.join(OUT, "report-ru-internal-draft-v3.pptx");
  const ruPdf = path.join(OUT, "report-ru-internal-draft-v3.pdf");
  if (ru?.pptxDownloadUrl) await download(ru.pptxDownloadUrl, ruPptx);
  if (ru?.pdfDownloadUrl) await download(ru.pdfDownloadUrl, ruPdf);
  check("RU PPTX saved", fs.existsSync(ruPptx), ruPptx);
  check("RU PDF saved", fs.existsSync(ruPdf), ruPdf);

  const enGen = await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "en" });
  check("EN report generate", enGen.status === 201);
  const enReportJson = enGen.json?.data?.reportJson;
  if (enReportJson) {
    fs.writeFileSync(path.join(OUT, "report-json-en.json"), JSON.stringify(enReportJson, null, 2));
  }

  const enRender = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "client",
    watermarkMode: "none",
    reportLanguage: "en",
  });
  const en = enRender.json?.data;
  check("EN/Client/None render", enRender.status === 201);
  check("EN no watermark", en?.watermarkMode === "none");
  check("EN 50 slides", en?.slideCount === 50, String(en?.slideCount));

  const enPptx = path.join(OUT, "report-en-client-none-v3.pptx");
  const enPdf = path.join(OUT, "report-en-client-none-v3.pdf");
  if (en?.pptxDownloadUrl) await download(en.pptxDownloadUrl, enPptx);
  if (en?.pdfDownloadUrl) await download(en.pdfDownloadUrl, enPdf);
  check("EN PPTX saved", fs.existsSync(enPptx), enPptx);
  check("EN PDF saved", fs.existsSync(enPdf), enPdf);

  const inspect = spawnSync("python", [path.join("scripts", "inspect-qa-artifacts.py"), OUT], {
    encoding: "utf-8",
  });
  if (inspect.stdout) console.log(inspect.stdout);
  if (inspect.stderr) console.error(inspect.stderr);
  if (inspect.status !== 0) {
    failures++;
    console.log("[FAIL] artifact inspection script");
  }

  console.log(`\nArtifacts directory: ${path.resolve(OUT)}`);
  console.log(failures === 0 ? "MANUAL QA PASSED" : `MANUAL QA FAILED (${failures} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
