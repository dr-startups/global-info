/**
 * Smoke test — Stage O5.4.2 Report Media Layout Polish.
 *
 * Run: npm run smoke:report-media-layout-o542
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const RENDERER_URL = process.env.RENDERER_URL ?? "http://localhost:8080";
const CASE_ID = process.env.O542_CASE_ID ?? "cmqzz1vbr00d2vdrsrjsgie2g";
const OUT = join(process.cwd(), "storage/digital-profile/smoke-o542-media-layout");
const H = { "Content-Type": "application/json", "x-actor-id": "smoke-o542-media-layout" };

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

async function download(url: string, dest: string): Promise<void> {
  const full = url.startsWith("http") ? url : `${APP_ORIGIN}${url}`;
  const res = await fetch(full, { headers: { "x-actor-id": "smoke-o542-media-layout" } });
  if (!res.ok) throw new Error(`download ${full} -> ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`O5.4.2 media layout smoke — case ${CASE_ID}\n`);

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

  check("render v3", render.templateVersion === "report-template-v3", String(render.templateVersion));
  check("50 slides", Number(render.slideCount) === 50, String(render.slideCount));

  const report = await api(`/cases/${CASE_ID}/report`);
  const reportJson = (report.reportJson ?? report) as Record<string, unknown>;
  const jsonPath = join(OUT, "report-json-ru.json");
  writeFileSync(jsonPath, JSON.stringify(reportJson, null, 2));

  const pptxPath = join(OUT, "report-ru-internal-draft-v3.pptx");
  if (!render.pptxDownloadUrl) {
    check("pptx url", false);
    process.exit(1);
  }
  await download(render.pptxDownloadUrl as string, pptxPath);

  const inspect = spawnSync(
    "python",
    [join("scripts", "inspect-o541-pptx.py"), pptxPath, jsonPath],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (inspect.stdout) process.stdout.write(inspect.stdout);
  if (inspect.stderr) process.stderr.write(inspect.stderr);
  check("PPTX layout + integrity inspection", inspect.status === 0, `exit ${inspect.status}`);

  const inspection = {
    caseId: CASE_ID,
    slideCount: render.slideCount,
    renderWarnings: render.warnings,
    layoutSmoke: "O5.4.2",
  };
  writeFileSync(join(OUT, "artifact-inspection.json"), JSON.stringify(inspection, null, 2));

  console.log(`\n${failures ? "FAILED" : "PASSED"} (${failures} failures)`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
