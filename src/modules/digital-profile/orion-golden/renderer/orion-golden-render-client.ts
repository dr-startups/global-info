/**
 * R10 — ORION Golden render client (HTTP + local Python fallback).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { digitalProfileConfig } from "../../config";
import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import type { OrionGoldenDeckManifest } from "../composer/orion-deck-composer";
import type { OrionGoldenReportSpec } from "../report-spec/orion-report-spec";

interface GoldenRenderResult {
  slideCount: number;
  pptxBase64: string;
  pdfBase64: string;
  pages: Array<{ pageNumber: number; contentBase64: string }>;
  pdfExportMode?: string;
  warnings?: string[];
}

export async function renderOrionGoldenArtifacts(input: {
  reportSpec: OrionGoldenReportSpec;
  deckManifest: OrionGoldenDeckManifest;
  assets: ReportAssetV1[];
  pptxOut: string;
  pdfOut: string;
  pagesOut: string;
}): Promise<{ pdfExportMode: "libreoffice" | "fitz-fallback" | "unknown"; warnings: string[] }> {
  const payload = {
    reportSpec: input.reportSpec,
    deckManifest: input.deckManifest,
    assets: input.assets
      .filter((a) => a.status === "ready" || a.imageData || a.imageUrl)
      .map((a) => ({
        assetRef: a.assetRef,
        kind: a.kind,
        title: a.title,
        caption: a.caption,
        status: a.status,
        imageData: a.imageData,
        imageUrl: a.imageUrl,
      })),
  };

  const url = `${digitalProfileConfig.rendererUrl}/orion/render-golden`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
    if (res.ok) {
      const json = (await res.json()) as GoldenRenderResult;
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
      const mode =
        json.pdfExportMode === "libreoffice"
          ? "libreoffice"
          : json.pdfExportMode === "fitz-fallback"
            ? "fitz-fallback"
            : "unknown";
      return { pdfExportMode: mode, warnings: json.warnings ?? [] };
    }
  } catch {
    // local fallback
  }

  const tmpPayload = join(dirname(input.pptxOut), "golden-render-payload.json");
  writeFileSync(tmpPayload, JSON.stringify(payload));
  const script = join(process.cwd(), "scripts", "render-orion-golden-artifacts.py");
  const proc = spawnSync("python", [script, tmpPayload, input.pptxOut, input.pdfOut, input.pagesOut], {
    encoding: "utf-8",
    cwd: process.cwd(),
  });
  if (proc.status !== 0) {
    throw new Error(`golden-render-failed:${proc.stderr?.slice(0, 400) ?? proc.stdout?.slice(0, 400) ?? "unknown"}`);
  }
  let mode: "libreoffice" | "fitz-fallback" | "unknown" = "unknown";
  try {
    const meta = JSON.parse(readFileSync(join(dirname(input.pptxOut), "golden-render-meta.json"), "utf-8")) as {
      pdfExportMode?: string;
    };
    if (meta.pdfExportMode === "libreoffice") mode = "libreoffice";
    else if (meta.pdfExportMode === "fitz-fallback") mode = "fitz-fallback";
  } catch {
    // optional
  }
  return { pdfExportMode: mode, warnings: [] };
}
