import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { digitalProfileConfig } from "../config";

interface RenderResult {
  slideCount: number;
  pptxBase64: string;
  pdfBase64: string;
  pages: Array<{ pageNumber: number; contentBase64: string }>;
}

/** Render ReportSpec v1 via renderer service or local Python fallback. */
export async function renderReportSpecArtifacts(input: {
  reportSpecPath: string;
  pptxOut: string;
  pdfOut: string;
  pagesOut: string;
}): Promise<string | null> {
  const reportSpec = JSON.parse(readFileSync(input.reportSpecPath, "utf-8"));
  const url = `${digitalProfileConfig.rendererUrl}/orion/render-report-spec`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportSpec, audience: "client" }),
      signal: AbortSignal.timeout(300_000),
    });
    if (res.ok) {
      const json = (await res.json()) as RenderResult;
      mkdirSync(dirname(input.pptxOut), { recursive: true });
      mkdirSync(dirname(input.pdfOut), { recursive: true });
      mkdirSync(input.pagesOut, { recursive: true });
      writeFileSync(input.pptxOut, Buffer.from(json.pptxBase64, "base64"));
      writeFileSync(input.pdfOut, Buffer.from(json.pdfBase64, "base64"));
      for (const page of json.pages ?? []) {
        writeFileSync(
          join(input.pagesOut, `page-${String(page.pageNumber).padStart(2, "0")}.png`),
          Buffer.from(page.contentBase64, "base64")
        );
      }
      return null;
    }
  } catch {
    // fall through to local python
  }

  const script = join(process.cwd(), "scripts", "render-orion-reportspec-artifacts.py");
  const proc = spawnSync("python", [script, input.reportSpecPath, input.pptxOut, input.pdfOut, input.pagesOut], {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
  if (proc.status !== 0) {
    return `render-failed:${proc.stderr?.slice(0, 200) ?? proc.stdout?.slice(0, 200) ?? "unknown"}`;
  }
  return null;
}
