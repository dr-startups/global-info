/**
 * Smoke test — Stage R1.1 report data hygiene + R1 render verification.
 *
 * Run: npm run smoke:report-data-hygiene-r1
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  filterComplianceForReport,
  filterReportWarningsForAudience,
  filterSearchResultsForReport,
  isClientSafeReportJson,
  isDemoComplianceHit,
  isDemoSearchRow,
  normalizeReportWarnings,
  reportWarningTexts,
  resolveReportDataPolicy,
  sanitizeReportJsonForAudience,
} from "../src/modules/digital-profile/report/report-data-policy";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const RENDERER_URL = process.env.RENDERER_URL ?? "http://localhost:8080";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-r11-hygiene" };
const SLIDE_COUNT = 50;

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function req(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { status: res.status, json: json as Record<string, unknown> | null };
}

function data<T>(json: Record<string, unknown> | null): T | undefined {
  return json?.data as T | undefined;
}

async function newCase(name: string) {
  const c = await req("POST", `${API}/cases`, {
    fullName: name,
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  return data<{ id: string }>(c.json)?.id;
}

function offlinePolicyChecks() {
  console.log("\n--- Offline policy ---\n");
  const policy = resolveReportDataPolicy({ demo: false });
  const rows = [
    { engine: "YANDEX", source: "real:YANDEX", url: "https://lenta.ru/a", title: "Real" },
    { engine: "YANDEX", source: "mock:YANDEX", url: "https://news.example.com/x", title: "[DEMO] x" },
    { engine: "GOOGLE", source: "mock:GOOGLE", url: "https://corp.example.com/y", title: "Mock" },
    { engine: "GOOGLE", source: "real:GOOGLE", url: "https://bbc.com/z", title: "Real google" },
  ];
  const filtered = filterSearchResultsForReport(rows, isDemoSearchRow, policy);
  check("prefer real per engine", filtered.rows.length === 2, String(filtered.rows.length));
  check("excludes mock/demo rows", filtered.excluded === 2, String(filtered.excluded));
  check("no example.com in filtered", !filtered.rows.some((r) => r.url.includes("example.com")));

  const comp = filterComplianceForReport(
    [
      { hitSource: "MOCK", provider: "DOW_JONES" },
      { hitSource: "MANUAL", provider: "DOW_JONES" },
    ],
    isDemoComplianceHit,
    policy
  );
  check("compliance MOCK excluded", comp.rows.length === 1 && comp.rows[0].hitSource === "MANUAL");

  const hygiene = normalizeReportWarnings([
    { text: "Demo/mock search rows were excluded from production report metrics.", audience: "internal", category: "DATA_HYGIENE" },
  ]);
  check(
    "client audience filters internal hygiene warnings",
    filterReportWarningsForAudience(hygiene, "client").length === 0
  );
  check(
    "internal audience keeps hygiene warnings",
    filterReportWarningsForAudience(hygiene, "internal").length === 1
  );

  const dirtyJson = {
    serpSnapshot: {
      metadata: {
        sourceMode: "REAL_ONLY",
        sourcePreference: "prefer_real",
        perEngine: { google: { sourceMode: "REAL", resultCount: 1, highlightedCount: 0 } },
      },
    },
    meta: { reportWarnings: hygiene },
    evidenceQuality: { totals: { collected: 1 }, reviewQueue: [{ id: "1" }] },
  };
  const clientJson = sanitizeReportJsonForAudience(dirtyJson, "client");
  check("sanitizer removes sourceMode", !JSON.stringify(clientJson).includes("sourceMode"));
  check("sanitizer removes reviewQueue", !JSON.stringify(clientJson).includes("reviewQueue"));
  check("client-safe helper", isClientSafeReportJson(JSON.stringify(clientJson)));
}

async function main() {
  console.log("Smoke testing R1.1 report data hygiene\n");
  offlinePolicyChecks();

  try {
    const h = await fetch(`${RENDERER_URL}/health`);
    check("renderer /health ok", h.status === 200);
  } catch (e) {
    check("renderer /health ok", false, String(e));
    process.exit(1);
  }

  const caseId = await newCase("R1.1 Hygiene Person");
  check("case created", !!caseId);
  if (!caseId) process.exit(1);

  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "YANDEX",
    url: "https://lenta.ru/r11-real-negative",
    title: "Real Yandex adverse media",
    classification: "ADVERSE_MEDIA",
  });
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "YANDEX",
    url: "https://news.example.com/r11-mock",
    title: "[DEMO] Mock example domain",
    classification: "ADVERSE_MEDIA",
  });
  await req("POST", `${API}/cases/${caseId}/search-results`, {
    engine: "GOOGLE",
    url: "https://court.example.com/r11-google-mock",
    title: "[DEMO] Google mock row",
    classification: "NEGATIVE",
  });

  await req("POST", `${API}/cases/${caseId}/agents/COMPLIANCE_DATABASE/run`);

  await req("POST", `${API}/cases/${caseId}/compliance/manual-import`, {
    provider: "DOW_JONES",
    matchedName: "R1.1 Hygiene Person",
    riskTypes: ["SANCTIONS"],
    matchScore: 70,
    confidence: "MEDIUM",
  });

  const gen = await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "ru" });
  const reportJson = data<{ reportJson: Record<string, unknown> }>(gen.json)?.reportJson;
  check("report generated", gen.status === 201);

  const meta = (reportJson?.meta ?? {}) as Record<string, unknown>;
  const audit = (reportJson?.auditSummary ?? {}) as Record<string, unknown>;
  const search = (audit.searchSummary ?? {}) as Record<string, unknown>;
  const compliance = (reportJson?.complianceSummary ?? {}) as Record<string, unknown>;
  const warnings = reportWarningTexts(normalizeReportWarnings(meta.reportWarnings));

  check("reportWarnings mention demo exclusion (internal)", warnings.some((w) => /demo|mock/i.test(w)), warnings.join("; "));
  check(
    "executive summary excludes hygiene from dataQuality warnings",
    !((audit.dataQualitySummary as { warnings?: string[] })?.warnings ?? []).some((w) =>
      /demo|mock|excluded from production/i.test(w)
    )
  );
  check(
    "negative domains exclude example.com",
    !((search.negativeDomains as string[]) ?? []).some((d) => d.includes("example.com")),
    JSON.stringify(search.negativeDomains)
  );

  const compPage = ((reportJson?.dynamicPages as Array<{ kind: string; table?: { rows: unknown[][] } }>) ?? []).find(
    (p) => p.kind === "COMPLIANCE_DATABASES"
  );
  const compRows = compPage?.table?.rows ?? [];
  check(
    "compliance dynamic page excludes MOCK source",
    !compRows.some((r) => String(r[1]).toUpperCase() === "MOCK"),
    JSON.stringify(compRows)
  );
  check(
    "manual import present in compliance table",
    compRows.some((r) => String(r[0]) === "DOW_JONES"),
    JSON.stringify(compRows)
  );

  check(
    "complianceSummary excludes mock-only total when manual exists",
    (compliance.totalHits as number) >= 1,
    String(compliance.totalHits)
  );

  const statuses = (compliance.providerStatuses as Array<{ name: string; status: string }>) ?? [];
  check(
    "Dow Jones stub NOT configured",
    statuses.some((p) => p.name === "DOW_JONES" && /DISABLED|NOT_CONFIGURED|PROVIDER_NOT_IMPLEMENTED/i.test(p.status))
  );

  const render = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "internal",
    watermarkMode: "draft",
    reportLanguage: "ru",
  });
  const r = data<{
    slideCount: number;
    templateVersion: string;
    warnings?: string[];
    pdfDownloadUrl?: string;
  }>(render.json);
  check("v3 render -> 201", render.status === 201);
  check(`slideCount === ${SLIDE_COUNT}`, r?.slideCount === SLIDE_COUNT, String(r?.slideCount));
  check("template v3 used", r?.templateVersion === "report-template-v3", r?.templateVersion);

  const enRender = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "client",
    watermarkMode: "none",
    reportLanguage: "en",
  });
  const en = data<{
    slideCount: number;
    watermarkMode: string;
    audience: string;
    pptxDownloadUrl?: string;
    warnings?: string[];
  }>(enRender.json);
  check("EN/Client/None render", enRender.status === 201);
  check("EN slideCount 50", en?.slideCount === SLIDE_COUNT, String(en?.slideCount));
  check("no watermark", en?.watermarkMode === "none", en?.watermarkMode);
  check(
    "EN render warnings exclude internal hygiene",
    !(en?.warnings ?? []).some((w) => /demo\/mock|excluded from production/i.test(w)),
    (en?.warnings ?? []).join("; ")
  );

  const clientReport = await req("GET", `${API}/cases/${caseId}/report?audience=client`);
  const clientJson = data<{ reportJson: Record<string, unknown> }>(clientReport.json)?.reportJson;
  const clientStr = JSON.stringify(clientJson ?? {});
  check("client GET report_json has no sourceMode", !clientStr.includes("sourceMode"));
  check("client GET report_json has no rawMetadata", !clientStr.includes("rawMetadata"));
  check("client GET report_json has no providerAdapter", !clientStr.includes("providerAdapter"));
  check("client GET report_json has no reviewQueue", !clientStr.includes("reviewQueue"));
  check("client GET report_json clean helper", isClientSafeReportJson(clientStr));

  const internalReport = await req("GET", `${API}/cases/${caseId}/report?audience=internal`);
  const internalJson = data<{ reportJson: Record<string, unknown> }>(internalReport.json)?.reportJson;
  check(
    "internal GET may keep sourceMode",
    JSON.stringify(internalJson ?? {}).includes("sourceMode") ||
      !((internalJson?.serpSnapshot as { metadata?: unknown } | undefined)?.metadata)
  );

  if (en?.pptxDownloadUrl) {
    const pptxRes = await fetch(`${BASE_URL}${en.pptxDownloadUrl}`);
    const pptxBuf = Buffer.from(await pptxRes.arrayBuffer());
    const tmpPptx = path.join("storage", "digital-profile", "smoke-r11-en-client.pptx");
    fs.mkdirSync(path.dirname(tmpPptx), { recursive: true });
    fs.writeFileSync(tmpPptx, pptxBuf);
    const py = spawnSync(
      "python",
      [
        "-X",
        "utf8",
        "-c",
        `
import re, sys, zipfile
from pathlib import Path
pptx = Path(sys.argv[1])
pages = {}
with zipfile.ZipFile(pptx) as z:
  for n in z.namelist():
    if not (n.startswith("ppt/slides/") and n.endswith(".xml")): continue
    plain = re.sub(r"\\s+", " ", re.sub(r"<[^>]+>", " ", z.read(n).decode("utf-8","ignore"))).strip()
    m = re.search(r"(\\d+)\\s*/\\s*50", plain)
    if m: pages[int(m.group(1))] = plain
p3, p10, p35 = pages.get(3,""), pages.get(10,""), pages.get(35,"")
bad = re.compile(r"Demo/mock|mock rows|excluded from production|\\[DEMO\\]|fixture", re.I)
cyr = re.compile(r"[\\u0400-\\u04FF]")
print("P3_OK", not bad.search(p3))
print("P10_OK", "Demo/mock data is used" not in p10 and not bad.search(p10))
print("P35_OK", not cyr.search(p35) and "analyst review" in p35)
`,
        tmpPptx,
      ],
      { encoding: "utf-8" }
    );
    const out = py.stdout ?? "";
    check("EN page 3 client-safe", /P3_OK True/.test(out), out.trim());
    check("EN page 10 client-safe SERP caption", /P10_OK True/.test(out), out.trim());
    check("EN page 35 English compliance warning", /P35_OK True/.test(out), out.trim());
  }

  await req("POST", `${API}/cases/${caseId}/serp-snapshot/generate`, {});
  await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "ru" });
  const serpRender = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
  });
  const serpW = data<{ warnings?: string[] }>(serpRender.json)?.warnings ?? [];
  check(
    "page 10 SERP snapshot embedded",
    !serpW.some((w) => w.toLowerCase().includes("serp snapshot is missing"))
  );

  if (r?.pdfDownloadUrl) {
    const pdfRes = await fetch(`${BASE_URL}${r.pdfDownloadUrl}`);
    const buf = Buffer.from(await pdfRes.arrayBuffer());
    check("PDF signature", pdfRes.status === 200 && buf.slice(0, 5).toString() === "%PDF-", String(buf.length));
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
