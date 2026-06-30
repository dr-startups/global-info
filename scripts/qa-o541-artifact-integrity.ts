/**
 * Manual QA — O5.4.1 artifact integrity (thumbnails + hyperlinks + themes).
 *
 * Run: npx tsx scripts/qa-o541-artifact-integrity.ts [caseId]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const OUT = join(process.cwd(), "storage/digital-profile/qa-o541-artifact-integrity");
const H = { "Content-Type": "application/json", "x-actor-id": "qa-o541-artifact-integrity" };

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
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
  const res = await fetch(full, { headers: { "x-actor-id": "qa-o541-artifact-integrity" } });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return true;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const caseId = process.argv[2] ?? process.env.O541_CASE_ID ?? "cmqzvdx3y0000mj0fpgz7vhj7";

  console.log(`O5.4.1 manual QA — case ${caseId}`);
  console.log(`Artifacts -> ${OUT}\n`);

  for (const spec of [
    { lang: "ru", audience: "internal", watermark: "draft", suffix: "ru-internal-draft" },
    { lang: "en", audience: "client", watermark: "none", suffix: "en-client-none" },
  ] as const) {
    await api(`/cases/${caseId}/report/generate`, {
      method: "POST",
      body: JSON.stringify({ reportLanguage: spec.lang }),
    });

    const render = await api(`/cases/${caseId}/report/render`, {
      method: "POST",
      body: JSON.stringify({
        templateVersion: "report-template-v3",
        audience: spec.audience,
        watermarkMode: spec.watermark,
        reportLanguage: spec.lang,
      }),
    });

    const report = await api(
      `/cases/${caseId}/report${spec.audience === "client" ? "?audience=client" : ""}`
    );
    const reportJson = (report.reportJson ?? report) as Record<string, unknown>;
    writeFileSync(join(OUT, `report-json-${spec.lang}.json`), JSON.stringify(reportJson, null, 2));

    console.log(
      `${spec.suffix}: slides=${render.slideCount ?? "?"} warnings=${JSON.stringify(render.warnings ?? [])}`
    );

    for (const ext of ["pptx", "pdf"] as const) {
      const url = render[`${ext}DownloadUrl`] as string | undefined;
      if (url) {
        await downloadArtifact(url, join(OUT, `report-${spec.suffix}-v3.${ext}`));
      }
    }
  }

  const ruPptx = join(OUT, "report-ru-internal-draft-v3.pptx");
  const ruJson = join(OUT, "report-json-ru.json");
  const inspect = spawnSync("python", ["scripts/inspect-o541-pptx.py", ruPptx, ruJson], {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
  if (inspect.stdout) process.stdout.write(inspect.stdout);
  if (inspect.stderr) process.stderr.write(inspect.stderr);

  const inspection = {
    caseId,
    inspectExitCode: inspect.status,
    stdout: inspect.stdout,
  };
  writeFileSync(join(OUT, "artifact-inspection.json"), JSON.stringify(inspection, null, 2));
  console.log(`\nartifact-inspection.json written`);
  process.exit(inspect.status === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
