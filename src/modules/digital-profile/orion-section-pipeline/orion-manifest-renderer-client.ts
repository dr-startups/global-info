import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { digitalProfileConfig } from "../config";
import { logOrionPipeline, warnOrionPipeline } from "./orion-pipeline-logger";

interface OrionManifestRenderResponse {
  slideCount: number;
  pptxBase64: string;
  pdfBase64: string;
  pages: Array<{
    pageNumber: number;
    width: number;
    height: number;
    contentBase64: string;
  }>;
}

/** Renders ORION manifest artifacts via the renderer microservice (Railway-safe). */
export async function renderOrionManifestViaRenderer(input: {
  reportJsonPath: string;
  pptxOut: string;
  pdfOut: string;
  pagesOut: string;
}): Promise<string | null> {
  const url = `${digitalProfileConfig.rendererUrl}/orion/render-manifest`;
  try {
    const reportJson = JSON.parse(readFileSync(input.reportJsonPath, "utf-8")) as Record<string, unknown>;
    const audience = input.pptxOut.toLowerCase().includes("client") ? "client" : "internal";
    logOrionPipeline("render", "orion-manifest-start", {
      audience,
      url,
    });
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reportJson, audience }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      warnOrionPipeline("render", "orion-manifest-http-error", {
        status: res.status,
        detail: detail.slice(0, 200),
      });
      return `r9-render-failed: renderer HTTP ${res.status}`;
    }
    const json = (await res.json()) as OrionManifestRenderResponse;
    mkdirSync(dirname(input.pptxOut), { recursive: true });
    mkdirSync(dirname(input.pdfOut), { recursive: true });
    mkdirSync(input.pagesOut, { recursive: true });
    writeFileSync(input.pptxOut, Buffer.from(json.pptxBase64, "base64"));
    writeFileSync(input.pdfOut, Buffer.from(json.pdfBase64, "base64"));
    for (const page of json.pages ?? []) {
      writeFileSync(
        `${input.pagesOut}/page-${String(page.pageNumber).padStart(2, "0")}.png`,
        Buffer.from(page.contentBase64, "base64")
      );
    }
    logOrionPipeline("render", "orion-manifest-success", {
      audience,
      slideCount: json.slideCount,
      pages: json.pages?.length ?? 0,
    });
    return null;
  } catch (error) {
    warnOrionPipeline("render", "orion-manifest-unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return `r9-render-failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
