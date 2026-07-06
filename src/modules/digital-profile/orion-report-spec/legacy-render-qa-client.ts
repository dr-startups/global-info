import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderLegacyReportJsonForQa } from "../services/report-renderer-service";
import type { ReportJson } from "../types";

export async function writeLegacyQaRenderArtifacts(input: {
  caseId: string;
  reportJson: ReportJson;
  pptxOut: string;
  pdfOut: string;
  pagesOut: string;
}): Promise<{
  slideCount: number;
  warnings: string[];
  pdfExportMode: "libreoffice" | "unknown";
  pageCount: number;
}> {
  const result = await renderLegacyReportJsonForQa({
    caseId: input.caseId,
    reportJson: input.reportJson,
  });
  mkdirSync(dirname(input.pptxOut), { recursive: true });
  mkdirSync(dirname(input.pdfOut), { recursive: true });
  mkdirSync(input.pagesOut, { recursive: true });
  writeFileSync(input.pptxOut, Buffer.from(result.pptxBase64, "base64"));
  writeFileSync(input.pdfOut, Buffer.from(result.pdfBase64, "base64"));

  const script = join(process.cwd(), "scripts", "inspect-r98a-visual-export.py");
  const proc = spawnSync(
    "python",
    [script, "--pdf", input.pdfOut, "--pptx", input.pptxOut, "--pages-out", input.pagesOut],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  let pageCount = 0;
  if (proc.status === 0 && proc.stdout) {
    try {
      const parsed = JSON.parse(proc.stdout) as { pageCount?: number };
      pageCount = parsed.pageCount ?? 0;
    } catch {
      pageCount = 0;
    }
  }

  return {
    slideCount: result.slideCount,
    warnings: result.warnings,
    pdfExportMode: result.pdfExportMode,
    pageCount,
  };
}
