/**
 * Manual QA R1.1.3 — risk precision + SERP auto-regen.
 * Run: node scripts/manual-qa-r113-risk-precision.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "manual-qa-r113" };
const OUT = path.join("storage", "digital-profile", "qa-r113-risk-precision");
const SUBJECT = "Томилин Константин Романович";

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

async function main() {
  console.log("Manual QA R1.1.3 — risk precision + SERP auto-regen\n");
  fs.mkdirSync(OUT, { recursive: true });

  const c = await req("POST", `${API}/cases`, {
    fullName: SUBJECT,
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = c.json?.data?.id;
  check("case created", !!caseId);
  if (!caseId) process.exit(1);

  const fixtures = [
    { engine: "YANDEX", url: "https://www.rusprofile.ru/ip/123", title: `ИП ${SUBJECT}`, snippet: "ИНН 7700000000 ОГРНИП" },
    { engine: "YANDEX", url: "https://www.klerk.ru/c/1", title: "Томилин К.Р.", snippet: "ликвидирован прекратил деятельность" },
    { engine: "GOOGLE", url: "https://science.example/1", title: "Константин Александрович Томилин", snippet: "известные ученые СЕМЬ ИСКУССТВ" },
    { engine: "YANDEX", url: "https://m.ok.ru/p/1", title: "Константин Томилин", snippet: "профиль пользователя" },
    { engine: "GOOGLE", url: "https://lenta.ru/neutral", title: "Neutral news", snippet: "Routine announcement" },
  ];
  for (const f of fixtures) {
    await req("POST", `${API}/cases/${caseId}/search-results`, { ...f, classification: "UNCLASSIFIED" });
  }
  await req("POST", `${API}/cases/${caseId}/compliance/manual-import`, {
    provider: "DOW_JONES",
    matchedName: SUBJECT,
    riskTypes: ["SANCTIONS"],
    matchScore: 65,
    confidence: "MEDIUM",
  });

  const gen = await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "ru" });
  const reportJson = gen.json?.data?.reportJson;
  fs.writeFileSync(path.join(OUT, "report-json-ru.json"), JSON.stringify(reportJson, null, 2));
  check("report auto-generated serpSnapshot", !!reportJson?.serpSnapshot?.id);

  const snap = (await req("GET", `${API}/cases/${caseId}/serp-snapshot`)).json?.data?.snapshot;
  check("neutral fixtures => themeCount 0", snap?.themeCount === 0, String(snap?.themeCount));
  check("neutral fixtures => highlightedCount 0", snap?.highlightedCount === 0, String(snap?.highlightedCount));

  const ruRender = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "internal",
    watermarkMode: "draft",
    reportLanguage: "ru",
  });
  const ru = ruRender.json?.data;
  if (ru?.pptxDownloadUrl) await download(ru.pptxDownloadUrl, path.join(OUT, "report-ru-internal-draft-v3.pptx"));
  if (ru?.pdfDownloadUrl) await download(ru.pdfDownloadUrl, path.join(OUT, "report-ru-internal-draft-v3.pdf"));
  check("RU 50 slides", ru?.slideCount === 50, String(ru?.slideCount));

  const list = (await req("GET", `${API}/cases/${caseId}/search-results`)).json?.data ?? [];
  const target = list.find((r) => String(r.url).includes("lenta.ru"))?.id;
  if (target) {
    await req("PATCH", `${BASE_URL}/api/digital-profile/search-results/${target}/classification`, {
      classification: "LEGAL_DISPUTE",
      riskTheme: "legal_dispute",
      rationale: "Manual QA R1.1.3",
    });
  }
  await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "ru" });
  const snap2 = (await req("GET", `${API}/cases/${caseId}/serp-snapshot`)).json?.data?.snapshot;
  check("after manual LEGAL themeCount >= 1", (snap2?.themeCount ?? 0) >= 1, String(snap2?.themeCount));

  const enGen = await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "en" });
  fs.writeFileSync(path.join(OUT, "report-json-en.json"), JSON.stringify(enGen.json?.data?.reportJson, null, 2));
  const enRender = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "client",
    watermarkMode: "none",
    reportLanguage: "en",
  });
  const en = enRender.json?.data;
  if (en?.pptxDownloadUrl) await download(en.pptxDownloadUrl, path.join(OUT, "report-en-client-none-v3.pptx"));
  if (en?.pdfDownloadUrl) await download(en.pdfDownloadUrl, path.join(OUT, "report-en-client-none-v3.pdf"));
  check("EN client render", enRender.status === 201);
  check("EN 50 slides", en?.slideCount === 50, String(en?.slideCount));

  const inspect = spawnSync("python", [path.join("scripts", "inspect-qa-artifacts.py"), OUT], { encoding: "utf-8" });
  if (inspect.stdout) console.log(inspect.stdout);
  if (inspect.status !== 0) failures++;

  console.log(`\nArtifacts: ${path.resolve(OUT)}`);
  console.log(failures === 0 ? "MANUAL QA PASSED" : `MANUAL QA FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
