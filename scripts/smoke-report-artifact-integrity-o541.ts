/**
 * Smoke test — Stage O5.4.1 Production Render Artifact Integrity.
 *
 * Prerequisites: dev server + renderer + DB with Tomilin (or env case).
 *
 * Run: npm run smoke:report-artifact-integrity-o541
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const RENDERER_URL = process.env.RENDERER_URL ?? "http://localhost:8080";
const CASE_ID = process.env.O541_CASE_ID ?? "cmqzz1vbr00d2vdrsrjsgie2g";
const OUT = join(process.cwd(), "storage/digital-profile/smoke-o541-artifact-integrity");
const H = { "Content-Type": "application/json", "x-actor-id": "smoke-o541-artifact-integrity" };

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return ((body as { data?: unknown }).data ?? body) as Record<string, unknown>;
}

async function download(url: string, dest: string): Promise<Buffer> {
  const full = url.startsWith("http") ? url : `${APP_ORIGIN}${url}`;
  const res = await fetch(full, { headers: { "x-actor-id": "smoke-o541-artifact-integrity" } });
  if (!res.ok) throw new Error(`download ${full} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return buf;
}

function forbiddenClientKeys(obj: unknown, path = ""): string[] {
  const bad = ["sourceMode", "rawMetadata", "internal", "debug", "thumbnailBytesBase64"];
  const hits: string[] = [];
  if (!obj || typeof obj !== "object") return hits;
  if (Array.isArray(obj)) {
    for (const item of obj) hits.push(...forbiddenClientKeys(item, path));
    return hits;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const p = path ? `${path}.${k}` : k;
    if (bad.includes(k)) hits.push(p);
    hits.push(...forbiddenClientKeys(v, p));
  }
  return hits;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`O5.4.1 artifact integrity smoke — case ${CASE_ID}\n`);

  try {
    const health = await fetch(`${RENDERER_URL}/health`);
    check("renderer /health ok", health.status === 200);
  } catch (e) {
    check("renderer /health ok", false, e instanceof Error ? e.message : String(e));
    process.exit(1);
  }

  await api(`/cases/${CASE_ID}/report/generate`, {
    method: "POST",
    body: JSON.stringify({ reportLanguage: "ru" }),
  });

  const render = await api(`/cases/${CASE_ID}/report/render`, {
    method: "POST",
    body: JSON.stringify({
      templateVersion: "report-template-v3",
      audience: "internal",
      watermarkMode: "draft",
      reportLanguage: "ru",
    }),
  });

  check("render -> v3", render.templateVersion === "report-template-v3", String(render.templateVersion));
  check("render slideCount ~50", Number(render.slideCount) >= 48, String(render.slideCount));

  const report = await api(`/cases/${CASE_ID}/report`);
  const reportJson = (report.reportJson ?? report) as Record<string, unknown>;
  const jsonPath = join(OUT, "report-json-ru.json");
  writeFileSync(jsonPath, JSON.stringify(reportJson, null, 2));

  const selected = reportJson.selectedEvidence as Record<string, unknown> | undefined;
  const imagesSelected =
    ((selected?.images as { selectedSubjectMatched?: unknown[] })?.selectedSubjectMatched?.length ?? 0);
  const videosSelected =
    ((selected?.videos as { selectedSubjectMatched?: unknown[] })?.selectedSubjectMatched?.length ?? 0);
  check("report_json has selectedEvidence", Boolean(selected));
  check("selected images count >= 0", imagesSelected >= 0, String(imagesSelected));
  check("selected videos count >= 0", videosSelected >= 0, String(videosSelected));

  const compliance = reportJson.complianceSummary as Record<string, unknown> | undefined;
  const complianceActive =
    Number(compliance?.activeMatches ?? 0) > 0 || Number(compliance?.providersChecked ?? 0) > 0;

  const pptxUrl = render.pptxDownloadUrl as string | undefined;
  if (!pptxUrl) {
    check("pptx download url present", false);
    process.exit(1);
  }

  const pptxPath = join(OUT, "report-ru-internal-draft-v3.pptx");
  await download(pptxUrl, pptxPath);
  check("pptx PK signature", (await import("node:fs")).readFileSync(pptxPath).slice(0, 2).toString() === "PK");

  const inspect = spawnSync(
    "python",
    [join("scripts", "inspect-o541-pptx.py"), pptxPath, jsonPath],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (inspect.stdout) process.stdout.write(inspect.stdout);
  if (inspect.stderr) process.stderr.write(inspect.stderr);
  check("PPTX artifact inspection", inspect.status === 0, `exit ${inspect.status}`);

  // EN client clean
  await api(`/cases/${CASE_ID}/report/generate`, {
    method: "POST",
    body: JSON.stringify({ reportLanguage: "en" }),
  });
  const enRender = await api(`/cases/${CASE_ID}/report/render`, {
    method: "POST",
    body: JSON.stringify({
      templateVersion: "report-template-v3",
      audience: "client",
      watermarkMode: "none",
      reportLanguage: "en",
    }),
  });
  const enReport = await api(`/cases/${CASE_ID}/report?audience=client`);
  const enJson = (enReport.reportJson ?? enReport) as Record<string, unknown>;
  writeFileSync(join(OUT, "report-json-en.json"), JSON.stringify(enJson, null, 2));
  const forbidden = forbiddenClientKeys(enJson);
  check("EN client JSON has no forbidden keys", forbidden.length === 0, forbidden.join(", "));

  if (enRender.pptxDownloadUrl) {
    await download(enRender.pptxDownloadUrl as string, join(OUT, "report-en-client-none-v3.pptx"));
  }

  // Page 36 theme guard from JSON VM
  const findings = (
    (selected?.riskFindings as { selectedSubjectMatchedOnly?: Array<{ theme?: string }> })
      ?.selectedSubjectMatchedOnly ?? []
  ).map((f) => String(f.theme ?? "").toLowerCase());
  if (!complianceActive) {
    for (const theme of ["pep_rca", "sanctions", "compliance_database"]) {
      check(`page36 JSON themes exclude ${theme}`, !findings.includes(theme));
    }
  }

  const inspection = {
    caseId: CASE_ID,
    imagesSelected,
    videosSelected,
    slideCount: render.slideCount,
    complianceActive,
    renderWarnings: render.warnings,
  };
  writeFileSync(join(OUT, "artifact-inspection.json"), JSON.stringify(inspection, null, 2));

  console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failures)`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
