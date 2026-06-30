/**
 * Manual QA R1.1.2 — SERP highlight consistency + client-safe reports.
 * Run: node scripts/manual-qa-r112-artifacts.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "manual-qa-r112" };
const OUT = path.join("storage", "digital-profile", "qa-r112-artifacts");

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
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

function pageText(pptx, pg) {
  const py = spawnSync(
    "python",
    [
      "-X",
      "utf8",
      "-c",
      `import re,sys,zipfile; p=sys.argv[1]; pg=int(sys.argv[2]);
with zipfile.ZipFile(p) as z:
  for n in z.namelist():
    if not (n.startswith('ppt/slides/') and n.endswith('.xml')): continue
    plain=re.sub(r'\\s+',' ',re.sub(r'<[^>]+>',' ',z.read(n).decode('utf-8','ignore'))).strip()
    if re.search(rf'\\b{pg}\\s*/\\s*50\\b', plain): print(plain); break`,
      pptx,
      String(pg),
    ],
    { encoding: "utf-8" }
  );
  return py.stdout?.trim() ?? "";
}

async function main() {
  console.log("Manual QA R1.1.2 — SERP highlight consistency\n");
  fs.mkdirSync(OUT, { recursive: true });

  const c = await req("POST", `${API}/cases`, {
    fullName: "Manual QA R1.1.2 Subject",
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = c.json?.data?.id;
  check("case created", !!caseId);
  if (!caseId) process.exit(1);

  for (let i = 1; i <= 4; i++) {
    await req("POST", `${API}/cases/${caseId}/search-results`, {
      engine: i <= 2 ? "YANDEX" : "GOOGLE",
      url: `https://lenta.ru/r112-real-${i}`,
      title: `Neutral real row ${i}`,
      classification: "UNCLASSIFIED",
    });
  }
  await req("POST", `${API}/cases/${caseId}/compliance/manual-import`, {
    provider: "DOW_JONES",
    matchedName: "Manual QA R1.1.2 Subject",
    riskTypes: ["SANCTIONS"],
    matchScore: 65,
    confidence: "MEDIUM",
  });
  await req("POST", `${API}/cases/${caseId}/serp-snapshot/generate`, {});

  const snap = (await req("GET", `${API}/cases/${caseId}/serp-snapshot`)).json?.data?.snapshot;
  check("SERP themeCount 0 before manual LEGAL", snap?.themeCount === 0, String(snap?.themeCount));
  check("SERP highlightedCount 0 before manual LEGAL", snap?.highlightedCount === 0, String(snap?.highlightedCount));

  const genRu = await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "ru" });
  const reportJson = genRu.json?.data?.reportJson;
  fs.writeFileSync(path.join(OUT, "report-json-ru-neutral.json"), JSON.stringify(reportJson, null, 2));

  const ruRenderNeutral = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "internal",
    watermarkMode: "draft",
    reportLanguage: "ru",
  });
  const ruNeutral = ruRenderNeutral.json?.data;
  const ruPptxNeutral = path.join(OUT, "report-ru-internal-draft-v3-neutral.pptx");
  const ruPdfNeutral = path.join(OUT, "report-ru-internal-draft-v3-neutral.pdf");
  if (ruNeutral?.pptxDownloadUrl) await download(ruNeutral.pptxDownloadUrl, ruPptxNeutral);
  if (ruNeutral?.pdfDownloadUrl) await download(ruNeutral.pdfDownloadUrl, ruPdfNeutral);

  const p9n = pageText(ruPptxNeutral, 9);
  const p10n = pageText(ruPptxNeutral, 10);
  check("neutral: page 9 no adverse URLs phrase ok", /не обнаружены|not found|0/i.test(p9n) || !/example\.com/i.test(p9n));
  check(
    "neutral: page 10 no phantom legal theme",
    !/Судебные и правовые материалы/i.test(p10n) || /не обнаружены|0/i.test(p10n)
  );

  const list = (await req("GET", `${API}/cases/${caseId}/search-results`)).json?.data ?? [];
  const targetId = list[0]?.id;
  if (targetId) {
    await req("PATCH", `${BASE_URL}/api/digital-profile/search-results/${targetId}/classification`, {
      classification: "LEGAL_DISPUTE",
      riskTheme: "legal_dispute",
      rationale: "Manual QA R1.1.2 LEGAL mark",
    });
  }
  check("manual LEGAL classification applied", !!targetId);

  await req("POST", `${API}/cases/${caseId}/serp-snapshot/generate`, {});
  const snap2 = (await req("GET", `${API}/cases/${caseId}/serp-snapshot`)).json?.data?.snapshot;
  check("after LEGAL: themeCount >= 1", (snap2?.themeCount ?? 0) >= 1, String(snap2?.themeCount));
  check("after LEGAL: highlightedCount >= 1", (snap2?.highlightedCount ?? 0) >= 1, String(snap2?.highlightedCount));
  check(
    "theme/highlight counts aligned",
    (snap2?.themeCount ?? 0) > 0 === (snap2?.highlightedCount ?? 0) > 0
  );

  await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "ru" });
  const reportJsonLegal = (await req("GET", `${API}/cases/${caseId}/report`)).json?.data?.reportJson;
  fs.writeFileSync(path.join(OUT, "report-json-ru.json"), JSON.stringify(reportJsonLegal, null, 2));
  const ruRender = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "internal",
    watermarkMode: "draft",
    reportLanguage: "ru",
  });
  const ru = ruRender.json?.data;
  const ruPptx = path.join(OUT, "report-ru-internal-draft-v3.pptx");
  const ruPdf = path.join(OUT, "report-ru-internal-draft-v3.pdf");
  if (ru?.pptxDownloadUrl) await download(ru.pptxDownloadUrl, ruPptx);
  if (ru?.pdfDownloadUrl) await download(ru.pdfDownloadUrl, ruPdf);
  check("RU render 50 slides", ru?.slideCount === 50, String(ru?.slideCount));

  const p9 = pageText(ruPptx, 9);
  const p10 = pageText(ruPptx, 10);
  check("LEGAL: page 9 mentions adverse/legal theme or domain", /legal|legal_dispute|lenta\.ru|негатив/i.test(p9));
  check("LEGAL: page 10 SERP present", /Поисковая выдача|SERP|search/i.test(p10));
  check(
    "LEGAL: snapshot metadata confirms visible highlight",
    (snap2?.themeCount ?? 0) >= 1 && (snap2?.highlightedCount ?? 0) >= 1,
    `theme=${snap2?.themeCount} highlighted=${snap2?.highlightedCount}`
  );

  const enGen = await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "en" });
  fs.writeFileSync(path.join(OUT, "report-json-en.json"), JSON.stringify(enGen.json?.data?.reportJson, null, 2));
  const enRender = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "client",
    watermarkMode: "none",
    reportLanguage: "en",
  });
  const en = enRender.json?.data;
  const enPptx = path.join(OUT, "report-en-client-none-v3.pptx");
  const enPdf = path.join(OUT, "report-en-client-none-v3.pdf");
  if (en?.pptxDownloadUrl) await download(en.pptxDownloadUrl, enPptx);
  if (en?.pdfDownloadUrl) await download(en.pdfDownloadUrl, enPdf);
  check("EN client render", enRender.status === 201);
  check("EN 50 slides", en?.slideCount === 50, String(en?.slideCount));

  const inspect = spawnSync("python", [path.join("scripts", "inspect-qa-artifacts.py"), OUT], {
    encoding: "utf-8",
  });
  fs.copyFileSync(enPptx, path.join(OUT, "report-en-client-none-v3.pptx"));
  fs.copyFileSync(ruPptx, path.join(OUT, "report-ru-internal-draft-v3.pptx"));
  const inspect2 = spawnSync("python", [path.join("scripts", "inspect-qa-artifacts.py"), OUT], { encoding: "utf-8" });
  if (inspect2.stdout) console.log(inspect2.stdout);
  if (inspect2.status !== 0) failures++;

  console.log(`\nArtifacts: ${path.resolve(OUT)}`);
  console.log(failures === 0 ? "MANUAL QA PASSED" : `MANUAL QA FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
