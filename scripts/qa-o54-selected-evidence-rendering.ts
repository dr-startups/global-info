/**
 * Manual QA — O5.4 selected evidence report rendering.
 *
 * Run: npx tsx scripts/qa-o54-selected-evidence-rendering.ts [caseId]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const OUT = join(process.cwd(), "storage/digital-profile/qa-o54-selected-evidence-rendering");
const H = { "Content-Type": "application/json", "x-actor-id": "qa-o54-selected-evidence-rendering" };

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
  const res = await fetch(full, { headers: { "x-actor-id": "qa-o54-selected-evidence-rendering" } });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return true;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const caseId = process.argv[2] ?? "cmqzz1vbr00d2vdrsrjsgie2g";

  console.log(`Using case ${caseId}`);

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

    const selected = reportJson.selectedEvidence as Record<string, unknown> | undefined;
    console.log(
      `${spec.suffix}: slides=${render.slideCount ?? "?"} imagesSelected=${(selected?.images as { selectedSubjectMatched?: unknown[] })?.selectedSubjectMatched?.length ?? "?"} videosSelected=${(selected?.videos as { selectedSubjectMatched?: unknown[] })?.selectedSubjectMatched?.length ?? "?"}`
    );

    for (const ext of ["pptx", "pdf"] as const) {
      const url = render[`${ext}DownloadUrl`] as string | undefined;
      if (url) {
        await downloadArtifact(url, join(OUT, `report-${spec.suffix}-v3.${ext}`));
      }
    }
  }

  console.log(`Artifacts written to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
