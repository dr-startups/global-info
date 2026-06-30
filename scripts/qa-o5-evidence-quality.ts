/**
 * Manual QA — O5 evidence quality artifacts.
 *
 * Run: npx tsx scripts/qa-o5-evidence-quality.ts [caseId]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const OUT = join(process.cwd(), "storage/digital-profile/qa-o5-evidence-quality");
const H = { "Content-Type": "application/json", "x-actor-id": "qa-o5-evidence-quality" };

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
  const res = await fetch(full, { headers: { "x-actor-id": "qa-o5-evidence-quality" } });
  if (!res.ok) return false;
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return true;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const caseId = process.argv[2];
  if (!caseId) throw new Error("Pass caseId");

  console.log(`Using case ${caseId}`);

  for (const agent of ["REAL_ORION_SEARCH_PROFILE", "RISK_CLASSIFIER_V1"]) {
    try {
      await api(`/cases/${caseId}/agents/${agent}/run`, { method: "POST", body: "{}" });
      console.log(`Agent ${agent} OK`);
    } catch (e) {
      console.warn(`Agent ${agent} skipped: ${e instanceof Error ? e.message : e}`);
    }
  }

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
      `Rendered ${spec.suffix}: slideCount=${render.slideCount}, template=${render.templateVersion}`
    );

    for (const [fmt, urlKey] of [
      ["pptx", "pptxDownloadUrl"],
      ["pdf", "pdfDownloadUrl"],
    ] as const) {
      const url = render[urlKey] as string | undefined;
      if (!url) {
        console.warn(`No ${fmt} URL for ${spec.suffix}`);
        continue;
      }
      const ok = await downloadArtifact(url, join(OUT, `report-${spec.suffix}-v3.${fmt}`));
      console.log(`${fmt.toUpperCase()} ${spec.suffix}: ${ok ? "saved" : "download failed"}`);
    }
  }

  console.log(`\nArtifacts written to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
