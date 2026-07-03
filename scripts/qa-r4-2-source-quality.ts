/**
 * Manual QA artifact generator for R4.2 source quality / dedup reasoning.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  sanitizeReportJsonForAudience,
  findClientReportPolicyViolations,
} from "../src/modules/digital-profile/report/report-data-policy";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const OUT = join(process.cwd(), "storage/digital-profile/qa-r4-2-source-quality");
const PAGES_OUT = join(OUT, "pages-pdf");
const H = { "Content-Type": "application/json", "x-actor-id": "qa-r4-2-source-quality" };

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init?.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return ((body as { data?: unknown }).data ?? body) as Record<string, unknown>;
}

async function downloadArtifact(url: string, dest: string): Promise<void> {
  const full = url.startsWith("http") ? url : `${APP_ORIGIN}${url}`;
  const res = await fetch(full, { headers: { "x-actor-id": "qa-r4-2-source-quality" } });
  if (!res.ok) throw new Error(`download ${full} -> ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function render(caseId: string, audience: "internal" | "client", watermarkMode: "draft" | "none") {
  return api(`/cases/${caseId}/report/render`, {
    method: "POST",
    body: JSON.stringify({
      templateVersion: "report-template-v3",
      audience,
      watermarkMode,
      reportLanguage: "ru",
    }),
  });
}

function exportPages(pdfPath: string, toPage: number) {
  const pdftoppm = spawnSync(
    "pdftoppm",
    ["-png", "-f", "1", "-l", String(toPage), pdfPath, join(PAGES_OUT, "page")],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (pdftoppm.status !== 0) {
    const fitzExport = spawnSync(
      "python",
      [
        "-c",
        [
          "import fitz",
          "from pathlib import Path",
          `pdf=Path(r'''${pdfPath}''')`,
          `out=Path(r'''${PAGES_OUT}''')`,
          `count=${toPage}`,
          "doc=fitz.open(str(pdf))",
          "for i in range(count):",
          "    p=doc[i].get_pixmap(matrix=fitz.Matrix(2,2))",
          "    p.save(str(out / f'page-{i+1:02d}.png'))",
          "print('fitz_pages', count)",
        ].join("\n"),
      ],
      { encoding: "utf-8", cwd: process.cwd() }
    );
    if (fitzExport.status !== 0) {
      throw new Error(`page PNG export failed: ${pdftoppm.stderr || ""} ${fitzExport.stderr || ""}`);
    }
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PAGES_OUT, { recursive: true });
  const caseId = process.argv[2] ?? process.env.R42_CASE_ID ?? "cmqzz1vbr00d2vdrsrjsgie2g";
  console.log(`R4.2 QA source quality — case ${caseId}`);
  console.log(`Artifacts -> ${OUT}\n`);

  await api(`/cases/${caseId}/report/generate`, {
    method: "POST",
    body: JSON.stringify({ reportLanguage: "ru" }),
  });

  const internal = await render(caseId, "internal", "draft");
  const internalSlides = Number(internal.slideCount ?? 0);
  const internalPptx = join(OUT, "report-v17-ru-internal-draft.pptx");
  const internalPdf = join(OUT, "report-v17-ru-internal-draft.pdf");
  await downloadArtifact(String(internal.pptxDownloadUrl ?? ""), internalPptx);
  await downloadArtifact(String(internal.pdfDownloadUrl ?? ""), internalPdf);

  const client = await render(caseId, "client", "draft");
  const clientSlides = Number(client.slideCount ?? 0);
  const clientPptx = join(OUT, "report-v17-ru-client.pptx");
  const clientPdf = join(OUT, "report-v17-ru-client.pdf");
  await downloadArtifact(String(client.pptxDownloadUrl ?? ""), clientPptx);
  await downloadArtifact(String(client.pdfDownloadUrl ?? ""), clientPdf);

  const report = await api(`/cases/${caseId}/report`);
  const internalJson = (report.reportJson ?? report) as Record<string, unknown>;
  const internalJsonPath = join(OUT, "report-json-ru-internal.json");
  writeFileSync(internalJsonPath, JSON.stringify(internalJson, null, 2));

  const clientJson = sanitizeReportJsonForAudience(
    JSON.parse(JSON.stringify(internalJson)) as Record<string, unknown>,
    "client"
  );
  const clientJsonPath = join(OUT, "report-json-ru-client.json");
  writeFileSync(clientJsonPath, JSON.stringify(clientJson, null, 2));

  const violations = findClientReportPolicyViolations(JSON.stringify(clientJson));
  const sq = (internalJson.sourceQualitySummary ?? {}) as Record<string, unknown>;
  console.log(`Internal slides: ${internalSlides}  |  Client slides: ${clientSlides}`);
  console.log(`Source quality summary uniqueSources: ${sq.uniqueSources ?? "n/a"}`);
  console.log(`Client JSON policy violations: ${violations.length}${violations.length ? " -> " + violations.join(", ") : ""}`);

  exportPages(internalPdf, Math.max(1, internalSlides));
  const focused = Array.from(
    new Set([8, 10, 13, 14, 17, 20, 24, 27, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 63, 72, internalSlides])
  );
  for (const n of focused) {
    const src = join(PAGES_OUT, `page-${String(n).padStart(2, "0")}.png`);
    const dst = join(OUT, `page-${String(n).padStart(2, "0")}.png`);
    try {
      copyFileSync(src, dst);
    } catch {
      /* optional */
    }
  }

  const inspectInternal = spawnSync(
    "python",
    ["scripts/inspect-0541-pptx.py", internalPptx, internalJsonPath],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (inspectInternal.stdout) process.stdout.write(inspectInternal.stdout);
  if (inspectInternal.stderr) process.stderr.write(inspectInternal.stderr);

  const inspectClient = spawnSync(
    "python",
    ["scripts/inspect-0541-pptx.py", clientPptx, clientJsonPath],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (inspectClient.stdout) process.stdout.write("\n--- CLIENT INSPECT ---\n" + inspectClient.stdout);
  if (inspectClient.stderr) process.stderr.write(inspectClient.stderr);

  const okCounts = internalSlides === 73 && clientSlides === 72;
  const okViolations = violations.length === 0;
  writeFileSync(
    join(OUT, "artifact-inspection.json"),
    JSON.stringify(
      {
        caseId,
        internalSlides,
        clientSlides,
        sourceQualitySummary: sq,
        clientPolicyViolations: violations,
        inspectInternalExit: inspectInternal.status,
        inspectClientExit: inspectClient.status,
      },
      null,
      2
    )
  );
  const rc = inspectInternal.status === 0 && okCounts && okViolations ? 0 : 1;
  process.exit(rc);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
