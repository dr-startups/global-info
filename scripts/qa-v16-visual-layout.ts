/**
 * Manual QA — Report v16 visual layout artifacts (Tomilin case).
 *
 * Run: npx tsx scripts/qa-v16-visual-layout.ts [caseId]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const OUT = join(process.cwd(), "storage/digital-profile/qa-v16-visual-layout");
const H = { "Content-Type": "application/json", "x-actor-id": "qa-v16-visual-layout" };

const FOCUS_PAGES = [8, 11, 13, 14, 20, 26, 27, 36];

const FETCH_TIMEOUT_MS = 600_000;

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...H, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return ((body as { data?: unknown }).data ?? body) as Record<string, unknown>;
}

async function downloadArtifact(url: string, dest: string): Promise<boolean> {
  const full = url.startsWith("http") ? url : `${APP_ORIGIN}${url}`;
  const res = await fetch(full, { headers: { "x-actor-id": "qa-v16-visual-layout" } });
  if (!res.ok) return false;
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const caseId = process.argv[2] ?? process.env.V16_CASE_ID ?? "cmqzz1vbr00d2vdrsrjsgie2g";

  console.log(`Report v16 manual QA — case ${caseId}`);
  console.log(`Focus pages: ${FOCUS_PAGES.join(", ")}`);
  console.log(`Artifacts -> ${OUT}\n`);

  await api(`/cases/${caseId}/report/generate`, {
    method: "POST",
    body: JSON.stringify({ reportLanguage: "ru" }),
  });

  const render = await api(`/cases/${caseId}/report/render`, {
    method: "POST",
    body: JSON.stringify({
      templateVersion: "report-template-v3",
      audience: "internal",
      watermarkMode: "draft",
      reportLanguage: "ru",
    }),
  });

  console.log(`report-v16: slides=${render.slideCount ?? "?"}`);

  for (const ext of ["pptx", "pdf"] as const) {
    const url = render[`${ext}DownloadUrl`] as string | undefined;
    if (url) {
      await downloadArtifact(url, join(OUT, `report-v16-ru-internal-draft.${ext}`));
    }
  }

  const report = await api(`/cases/${caseId}/report`);
  const jsonPath = join(OUT, "report-json-ru.json");
  writeFileSync(jsonPath, JSON.stringify(report.reportJson ?? report, null, 2));

  const pptxPath = join(OUT, "report-v16-ru-internal-draft.pptx");
  const inspect = spawnSync("python", ["scripts/inspect-o541-pptx.py", pptxPath, jsonPath], {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
  if (inspect.stdout) process.stdout.write(inspect.stdout);
  if (inspect.stderr) process.stderr.write(inspect.stderr);

  writeFileSync(
    join(OUT, "artifact-inspection.json"),
    JSON.stringify(
      {
        caseId,
        focusPages: FOCUS_PAGES,
        slideCount: render.slideCount,
        inspectExitCode: inspect.status,
        layoutVersion: "v16",
      },
      null,
      2
    )
  );

  process.exit(inspect.status === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
