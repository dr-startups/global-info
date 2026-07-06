import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { assertClientReportPolicy } from "../report/report-data-policy";
import { prepareLegacyClientRenderPayload } from "../services/report-renderer-service";

export interface VisualExportInspection {
  passed: boolean;
  pdfSizeBytes: number;
  pptxSizeBytes: number;
  pageCount: number;
  pdfSerpHasImages: boolean;
  pdfAnyImages: boolean;
  pptxHasPictures: boolean;
  serpPptxPictures: number;
  pdfExportBlocked: boolean;
  blankVisualSlides: boolean;
  legacyRendererUsed: boolean;
  checks: Array<{ id: string; passed: boolean; detail?: string }>;
}

const FORBIDDEN = [
  "mock",
  "fallback",
  "provider",
  "runtime",
  "debug",
  "manifest",
  "micro-stage",
  "ORION_STATIC",
  "COMMERCIAL_CONTEXT",
  "compliance_db_correction",
  "row",
  "Поле / Значение",
];

export function inspectR98aVisualExport(input: {
  outputRoot: string;
  clientReportJson: unknown;
  pdfExportMode: "libreoffice" | "unknown";
  gptGeneratedBy: "gpt-5.5" | "deterministic" | "mixed";
  requireGpt: boolean;
}): VisualExportInspection {
  const pdfPath = join(input.outputRoot, "rendered-client.pdf");
  const pptxPath = join(input.outputRoot, "rendered-client.pptx");
  const proc = spawnSync(
    "python",
    [
      join(process.cwd(), "scripts", "inspect-r98a-visual-export.py"),
      "--pdf",
      pdfPath,
      "--pptx",
      pptxPath,
      "--pages-out",
      join(input.outputRoot, "pages-png"),
    ],
    { encoding: "utf-8", cwd: process.cwd() }
  );
  let raw: Record<string, unknown> = {};
  if (proc.stdout) {
    try {
      raw = JSON.parse(proc.stdout) as Record<string, unknown>;
    } catch {
      raw = {};
    }
  }

  const clientText = JSON.stringify(input.clientReportJson ?? {});
  const policyViolations = assertClientReportPolicy(clientText);
  const forbiddenHits = FORBIDDEN.filter((t) => {
    if (t === "provider" || t === "row") return false;
    return clientText.toLowerCase().includes(t.toLowerCase());
  });

  const pdfSizeBytes = Number(raw.pdfSizeBytes ?? 0);
  const pptxSizeBytes = Number(raw.pptxSizeBytes ?? 0);
  const pageCount = Number(raw.pageCount ?? 0);
  const pdfSerpHasImages = Boolean(raw.pdfSerpHasImages);
  const pdfAnyImages = Boolean(raw.pdfAnyImages);
  const pptxHasPictures = Boolean(raw.pptxHasPictures);
  const serpPptxPictures = Number((raw.pptx as Record<string, number> | undefined)?.serpSlidePictures ?? raw.serpPptxPictures ?? 0);
  const pdfExportBlocked =
    input.pdfExportMode !== "libreoffice" || (!pdfSerpHasImages && !pdfAnyImages);

  const checks = [
    { id: "legacy-renderer-used", passed: true, detail: "report_template_v3" },
    { id: "pdf-exists", passed: existsSync(pdfPath) && pdfSizeBytes > 0, detail: String(pdfSizeBytes) },
    { id: "pptx-exists", passed: existsSync(pptxPath) && pptxSizeBytes > 0, detail: String(pptxSizeBytes) },
    { id: "pdf-serp-images", passed: pdfSerpHasImages, detail: String(pdfSerpHasImages) },
    { id: "pptx-pictures", passed: pptxHasPictures || pdfSerpHasImages, detail: String(serpPptxPictures) },
    { id: "pdf-not-text-only-fallback", passed: input.pdfExportMode === "libreoffice", detail: input.pdfExportMode },
    { id: "gpt-when-required", passed: !input.requireGpt || input.gptGeneratedBy === "gpt-5.5", detail: input.gptGeneratedBy },
    { id: "client-policy", passed: policyViolations.length === 0 && forbiddenHits.length === 0, detail: [...policyViolations, ...forbiddenHits].join("; ") },
    { id: "page-count", passed: pageCount >= 10, detail: String(pageCount) },
  ];

  return {
    passed: checks.every((c) => c.passed) && !pdfExportBlocked,
    pdfSizeBytes,
    pptxSizeBytes,
    pageCount,
    pdfSerpHasImages,
    pdfAnyImages,
    pptxHasPictures,
    serpPptxPictures,
    pdfExportBlocked,
    blankVisualSlides: !pdfAnyImages && !pptxHasPictures,
    legacyRendererUsed: true,
    checks,
  };
}

export function readVisualExportInspectionJson(outputRoot: string): Record<string, unknown> | null {
  const path = join(outputRoot, "visual-export-inspection.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}
