/**
 * Manual QA artifact generator for R3.5 compliance / risk intelligence polish.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.DIGITAL_PROFILE_API_BASE ?? "http://localhost:3000/api/digital-profile";
const APP_ORIGIN = BASE.replace(/\/api\/digital-profile\/?$/, "");
const OUT = join(process.cwd(), "storage/digital-profile/qa-r3-5-compliance-risk");
const PAGES_OUT = join(OUT, "pages-pdf");
const H = { "Content-Type": "application/json", "x-actor-id": "qa-r3-5-compliance-risk" };

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
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 500)}`);
  return ((body as { data?: unknown }).data ?? body) as Record<string, unknown>;
}

async function downloadArtifact(url: string, dest: string): Promise<void> {
  const full = url.startsWith("http") ? url : `${APP_ORIGIN}${url}`;
  const res = await fetch(full, { headers: { "x-actor-id": "qa-r3-5-compliance-risk" } });
  if (!res.ok) throw new Error(`download ${full} -> ${res.status}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(PAGES_OUT, { recursive: true });
  const caseId = process.argv[2] ?? process.env.R35_CASE_ID ?? "cmqzz1vbr00d2vdrsrjsgie2g";
  console.log(`R3.5 QA artifacts — case ${caseId}`);
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

  const slideCount = Number(render.slideCount ?? 0);
  const report = await api(`/cases/${caseId}/report`);
  const reportJson = (report.reportJson ?? report) as Record<string, unknown>;

  const jsonPath = join(OUT, "report-json-ru.json");
  const pptxPath = join(OUT, "report-v17-ru-internal-draft.pptx");
  const pdfPath = join(OUT, "report-v17-ru-internal-draft.pdf");
  writeFileSync(jsonPath, JSON.stringify(reportJson, null, 2));

  const pptxUrl = String(render.pptxDownloadUrl ?? "");
  const pdfUrl = String(render.pdfDownloadUrl ?? "");
  if (!pptxUrl || !pdfUrl) throw new Error("Render response missing pptx/pdf download URLs");
  await downloadArtifact(pptxUrl, pptxPath);
  await downloadArtifact(pdfUrl, pdfPath);

  const inspect = spawnSync("python", ["scripts/inspect-0541-pptx.py", pptxPath, jsonPath], {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
  if (inspect.stdout) process.stdout.write(inspect.stdout);
  if (inspect.stderr) process.stderr.write(inspect.stderr);

  const toPage = Math.max(1, slideCount);
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
      throw new Error(
        `page PNG export failed: ${pdftoppm.stderr || pdftoppm.stdout || ""} ${fitzExport.stderr || fitzExport.stdout || ""}`
      );
    }
  }

  const diagnosticsPage = toPage >= 73 ? 73 : toPage;
  const focusedPages = Array.from(
    new Set([4, 17, 21, 29, 31, 32, 33, 34, 35, 36, 60, 61, 63, 64, 65, 72, diagnosticsPage])
  );
  for (const n of focusedPages) {
    const file = join(PAGES_OUT, `page-${String(n).padStart(2, "0")}.png`);
    const focusCopy = join(OUT, `page-${String(n).padStart(2, "0")}.png`);
    try {
      copyFileSync(file, focusCopy);
    } catch {
      /* optional */
    }
  }

  writeFileSync(
    join(OUT, "artifact-inspection.json"),
    JSON.stringify({ caseId, slideCount, inspectExitCode: inspect.status, focusedPages }, null, 2)
  );
  process.exit(inspect.status === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
