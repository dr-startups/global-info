/**
 * Manual QA — O5.4.2 media layout polish artifacts.
 *
 * Run: npx tsx scripts/qa-o542-media-layout.ts [caseId]
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const OUT = join(process.cwd(), "storage/digital-profile/qa-o542-media-layout");
const H = { "Content-Type": "application/json", "x-actor-id": "qa-o542-media-layout" };

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
  const res = await fetch(full, { headers: { "x-actor-id": "qa-o542-media-layout" } });
  if (!res.ok) return false;
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return true;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const caseId = process.argv[2] ?? process.env.O542_CASE_ID ?? "cmqzvdx3y0000mj0fpgz7vhj7";

  console.log(`O5.4.2 manual QA — case ${caseId}`);
  console.log(`Artifacts -> ${OUT}\n`);

  const inspection: Record<string, unknown> = { caseId, checks: [] as string[] };

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

    console.log(`${spec.suffix}: slides=${render.slideCount ?? "?"}`);

    for (const ext of ["pptx", "pdf"] as const) {
      const url = render[`${ext}DownloadUrl`] as string | undefined;
      if (url) {
        await downloadArtifact(url, join(OUT, `report-${spec.suffix}-v3.${ext}`));
      }
    }

    const report = await api(
      `/cases/${caseId}/report${spec.audience === "client" ? "?audience=client" : ""}`
    );
    writeFileSync(
      join(OUT, `report-json-${spec.lang}.json`),
      JSON.stringify(report.reportJson ?? report, null, 2)
    );
  }

  const ruPptx = join(OUT, "report-ru-internal-draft-v3.pptx");
  const ruJson = join(OUT, "report-json-ru.json");
  const inspect = spawnSync("python", ["scripts/inspect-o541-pptx.py", ruPptx, ruJson], {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
  if (inspect.stdout) process.stdout.write(inspect.stdout);
  if (inspect.stderr) process.stderr.write(inspect.stderr);

  inspection.inspectExitCode = inspect.status;
  writeFileSync(join(OUT, "artifact-inspection.json"), JSON.stringify(inspection, null, 2));
  process.exit(inspect.status === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
