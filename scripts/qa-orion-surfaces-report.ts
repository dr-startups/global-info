/**
 * Manual QA — generate O1–O4 report artifacts under storage/digital-profile/qa-o1-o4-surfaces/
 *
 * Run (dev server + renderer required):
 *   npx tsx scripts/qa-orion-surfaces-report.ts [caseId]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const OUT = join(process.cwd(), "storage/digital-profile/qa-o1-o4-surfaces");
const H = { "Content-Type": "application/json", "x-actor-id": "qa-orion-surfaces" };

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...H, ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
  const wrapped = body as { data?: unknown };
  return (wrapped.data ?? body) as Record<string, unknown>;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let resolvedCaseId: string | undefined = process.argv[2];
  if (!resolvedCaseId) {
    const cases = (await api("/cases")) as { items?: { id: string }[] };
    const first = cases.items?.[0];
    resolvedCaseId = first?.id;
  }
  if (!resolvedCaseId) throw new Error("No caseId — pass one or seed demo data.");
  const caseId = resolvedCaseId;

  console.log(`Using case ${caseId}`);

  for (const agent of [
    "REAL_ORION_SEARCH_PROFILE",
    "RISK_CLASSIFIER_V1",
  ]) {
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
    const gen = await api(`/cases/${caseId}/report/generate`, {
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

    const reportJson = render.reportJson ?? gen.reportJson;
    writeFileSync(
      join(OUT, `report-json-${spec.lang}.json`),
      JSON.stringify(reportJson ?? {}, null, 2)
    );

    console.log(`Rendered ${spec.suffix}: slideCount=${render.slideCount}, template=${render.templateVersion}`);

    for (const [fmt, urlKey] of [
      ["pptx", "pptxDownloadUrl"],
      ["pdf", "pdfDownloadUrl"],
    ] as const) {
      const url = render[urlKey] as string | undefined;
      if (!url) continue;
      const dl = await fetch(url.startsWith("http") ? url : `http://localhost:3000${url}`);
      if (!dl.ok) continue;
      const buf = Buffer.from(await dl.arrayBuffer());
      writeFileSync(join(OUT, `report-${spec.suffix}-v3.${fmt}`), buf);
    }
  }

  console.log(`\nArtifacts written to ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
