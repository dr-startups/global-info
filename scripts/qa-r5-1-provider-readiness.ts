/**
 * Manual QA artifact generator for R5.1 provider readiness.
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
const OUT = join(process.cwd(), "storage/digital-profile/qa-r5-1-provider-readiness");
const PAGES_OUT = join(OUT, "pages-pdf");
const CLIENT_PAGES_OUT = join(OUT, "client-pages-pdf");
const H = { "Content-Type": "application/json", "x-actor-id": "qa-r5-1-provider-readiness" };

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
  const res = await fetch(full, { headers: { "x-actor-id": "qa-r5-1-provider-readiness" } });
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

function exportPages(pdfPath: string, outDir: string, toPage: number) {
  const fitzExport = spawnSync(
    "python",
    [
      "-c",
      [
        "import fitz",
        "from pathlib import Path",
        `pdf=Path(r'''${pdfPath}''')`,
        `out=Path(r'''${outDir}''')`,
        `count=${toPage}`,
        "out.mkdir(parents=True, exist_ok=True)",
        "doc=fitz.open(str(pdf))",
        "for i in range(min(count, len(doc))):",
        "    p=doc[i].get_pixmap(matrix=fitz.Matrix(2,2))",
        "    p.save(str(out / f'page-{i+1:02d}.png'))",
        "print('fitz_pages', min(count, len(doc)))",
      ].join("\n"),
    ],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  if (fitzExport.status !== 0) {
    throw new Error(`page PNG export failed: ${fitzExport.stderr || ""}`);
  }
}

function writeClientPolicyInspection(clientJson: Record<string, unknown>) {
  const text = JSON.stringify(clientJson);
  const forbidden = [
    "providerAdapter",
    "rawMetadata",
    "sourceMode",
    "internalReason",
    "internalCaption",
    "artifactPathInternal",
    "warningCodes",
    "missingConfigKeys",
    "requiredEnv",
    "screenshotId",
    "queryId",
    "runtimeKind",
  ];
  const hits = forbidden.filter((t) => text.includes(t));
  writeFileSync(
    join(OUT, "client-policy-inspection.json"),
    JSON.stringify(
      {
        totalForbiddenHits: hits.length,
        hits,
        status: hits.length === 0 ? "PASS" : "BLOCKED",
      },
      null,
      2
    )
  );
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PAGES_OUT, { recursive: true });
  mkdirSync(CLIENT_PAGES_OUT, { recursive: true });
  const caseId = process.argv[2] ?? process.env.R51_CASE_ID ?? "cmqzz1vbr00d2vdrsrjsgie2g";
  console.log(`R5.1 QA provider readiness — case ${caseId}`);
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
  const readiness = (internalJson.providerReadinessSummary ?? {}) as Record<string, unknown>;
  console.log(`Internal slides: ${internalSlides}  |  Client slides: ${clientSlides}`);
  console.log(
    `Provider readiness total/ready: ${readiness.totalProviders ?? "n/a"}/${readiness.readyCount ?? "n/a"}`
  );
  console.log(`Client JSON policy violations: ${violations.length}`);

  exportPages(internalPdf, PAGES_OUT, Math.max(1, internalSlides));
  exportPages(clientPdf, CLIENT_PAGES_OUT, Math.max(1, clientSlides));

  const focused = Array.from(new Set([10, 13, 14, 27, 51, 52, 59, 60, 63, 72, 73]));
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

  writeClientPolicyInspection(clientJson);

  writeFileSync(
    join(OUT, "artifact-inspection.json"),
    JSON.stringify(
      {
        caseId,
        internalSlides,
        clientSlides,
        providerReadinessSummary: readiness,
        clientPolicyViolations: violations,
        inspectInternalExit: inspectInternal.status,
        inspectClientExit: inspectClient.status,
      },
      null,
      2
    )
  );
  const okCounts = internalSlides === 73 && clientSlides === 72;
  const rc =
    inspectInternal.status === 0 && inspectClient.status === 0 && violations.length === 0 && okCounts
      ? 0
      : 1;
  process.exit(rc);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
