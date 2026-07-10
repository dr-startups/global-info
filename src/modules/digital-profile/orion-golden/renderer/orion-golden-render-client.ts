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

function assetDiag(assets: ReportAssetV1[]) {
  return assets
    .filter((a) => a.kind === "synthetic_serp" || a.kind === "live_serp" || a.kind === "captured_serp")
    .slice(0, 12)
    .map((a) => ({
      assetRef: a.assetRef,
      kind: a.kind,
      status: a.status,
      imageDataChars: String(a.imageData ?? "").length,
      hasStorageKey: Boolean(a.storageKey),
    }));
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
      .filter((a) => a.status === "ready" || a.imageData || a.imageUrl || a.storageKey)
      .map((a) => ({
        assetRef: a.assetRef,
        kind: a.kind,
        title: a.title,
        caption: a.caption,
        status: a.status,
        imageData: a.imageData,
        imageUrl: a.imageUrl,
        storageKey: a.storageKey,
      })),
  };

  const serpSlideCount = input.deckManifest.finalSlides.filter(
    (s) => s.template === "orion_golden_serp_screenshot"
  ).length;
  console.info("[orion-golden-render-client] payload", {
    assetCount: payload.assets.length,
    serpSlideCount,
    serpAssets: assetDiag(input.assets),
  });

  const url = `${digitalProfileConfig.rendererUrl}/orion/render-golden`;
  let httpError: string | null = null;
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
      console.info("[orion-golden-render-client] http ok", {
        pdfExportMode: mode,
        slideCount: json.slideCount,
        warnings: json.warnings ?? [],
      });
      writeFileSync(
        join(dirname(input.pptxOut), "golden-render-meta.json"),
        JSON.stringify(
          {
            pdfExportMode: mode,
            slideCount: json.slideCount,
            warnings: json.warnings ?? [],
            serpAssets: assetDiag(input.assets),
            via: "http",
          },
          null,
          2
        ),
        "utf-8"
      );
      return { pdfExportMode: mode, warnings: json.warnings ?? [] };
    }
    httpError = `http-${res.status}:${(await res.text()).slice(0, 300)}`;
    console.warn("[orion-golden-render-client] http not ok", httpError);
  } catch (err) {
    httpError = err instanceof Error ? err.message : String(err);
    console.warn("[orion-golden-render-client] http failed, trying local python", httpError);
  }

  const tmpPayload = join(dirname(input.pptxOut), "golden-render-payload.json");
  writeFileSync(tmpPayload, JSON.stringify(payload));
  const script = join(process.cwd(), "scripts", "render-orion-golden-artifacts.py");
  const proc = spawnSync("python", [script, tmpPayload, input.pptxOut, input.pdfOut, input.pagesOut], {
    encoding: "utf-8",
    cwd: process.cwd(),
    env: {
      ...process.env,
      PYTHONPATH: [join(process.cwd(), "renderer"), process.env.PYTHONPATH]
        .filter(Boolean)
        .join(process.platform === "win32" ? ";" : ":"),
    },
  });
  if (proc.status !== 0) {
    throw new Error(
      `golden-render-failed:${httpError ? `http=${httpError}; ` : ""}${proc.stderr?.slice(0, 400) ?? proc.stdout?.slice(0, 400) ?? "unknown"}`
    );
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
  console.info("[orion-golden-render-client] local python ok", { pdfExportMode: mode, httpError });
  return { pdfExportMode: mode, warnings: httpError ? [`http-fallback:${httpError}`] : [] };
}
