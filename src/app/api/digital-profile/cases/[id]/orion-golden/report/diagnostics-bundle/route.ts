import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { NextResponse, type NextRequest } from "next/server";
import {
  withModule,
  ValidationError,
  NotFoundError,
} from "@/modules/digital-profile/http/errors";
import { requireOrionAdminApiAccess } from "@/modules/digital-profile/orion-golden/auth/orion-admin-auth";
import {
  getLatestOrionClassicAuditRunRecord,
  getOrionClassicAuditRunRecord,
} from "@/modules/digital-profile/services/orion-classic-audit-report-service";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type RouteContext = { params: Promise<{ id: string }> };

const REQUIRED_FILES = [
  "rendered-client.pdf",
  "rendered-client.pptx",
  "arsenkin-full-first36-plan.json",
  "arsenkin-surface-coverage.json",
  "ai-answer-observations.json",
  "ai-answer-evaluations.json",
  "composite-serp-merge-provenance.json",
  "client-content-binding.json",
  "report-assets.json",
  "final-deck-manifest.json",
  "cross-slide-metric-report.json",
  "client-copy-report.json",
  "geometry-report.json",
  "first36-acceptance.json",
] as const;

const OPTIONAL_FILES = [
  "contact-sheet.png",
  "metric-consistency-report.json",
  "source-artifact-reconciliation.json",
] as const;

export const GET = withModule(async (req: NextRequest, ctx: RouteContext) => {
  const { id } = await ctx.params;
  await requireOrionAdminApiAccess(req, id, "view");

  const runId = String(req.nextUrl.searchParams.get("runId") ?? "").trim();
  const run =
    (runId ? getOrionClassicAuditRunRecord(id, runId) : null) ??
    getLatestOrionClassicAuditRunRecord(id);
  if (!run || run.status !== "completed") {
    throw new NotFoundError("Completed classic audit run not found.");
  }
  const outputRoot = run.outputRoot;
  const pagesDir = join(outputRoot, "pages-png");

  const missingRequired: string[] = REQUIRED_FILES.filter((name) => !existsSync(join(outputRoot, name)));
  if (!existsSync(pagesDir)) missingRequired.push("pages-png");
  if (missingRequired.length > 0) {
    throw new ValidationError(
      `Diagnostics bundle cannot be built: missing required artifacts: ${missingRequired.join(", ")}`
    );
  }

  const zip = new JSZip();
  const addFile = (absPath: string, relPath: string): void => {
    zip.file(relPath.replace(/\\/g, "/"), readFileSync(absPath));
  };

  for (const name of REQUIRED_FILES) addFile(join(outputRoot, name), name);
  for (const name of OPTIONAL_FILES) {
    const p = join(outputRoot, name);
    if (existsSync(p)) addFile(p, name);
  }

  // Pages PNG are included under a relative folder in zip.
  const pageFiles = readdirSync(pagesDir).filter((n) => /\.png$/i.test(n)).sort();
  if (pageFiles.length === 0) throw new ValidationError("pages-png is empty.");
  for (const name of pageFiles) addFile(join(pagesDir, name), `pages-png/${name}`);

  const data = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const fileName = `orion-classic-diagnostics-${run.runId}.zip`;

  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="${fileName}"`,
    },
  });
});
