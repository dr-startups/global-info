import { digitalProfileConfig } from "../config";

export interface LexisRendererPage {
  pageNumber: number;
  width: number;
  height: number;
  contentBase64: string;
}

export interface LexisRendererProcessResult {
  text: string;
  pages: LexisRendererPage[];
  parserWarnings: string[];
  conversionWarnings: string[];
}

/** Calls the renderer microservice to extract text and render DOCX visual pages. */
export async function processLexisDocxViaRenderer(
  fileBuffer: Buffer
): Promise<LexisRendererProcessResult | null> {
  const url = `${digitalProfileConfig.rendererUrl}/lexis/process-docx`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docxBase64: fileBuffer.toString("base64"),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      console.warn(
        `[lexis-import] renderer HTTP ${res.status} from ${url}`
      );
      return null;
    }
    const json = (await res.json()) as LexisRendererProcessResult;
    return {
      text: json.text ?? "",
      pages: Array.isArray(json.pages) ? json.pages : [],
      parserWarnings: Array.isArray(json.parserWarnings) ? json.parserWarnings : [],
      conversionWarnings: Array.isArray(json.conversionWarnings)
        ? json.conversionWarnings
        : [],
    };
  } catch (error) {
    console.warn(
      "[lexis-import] renderer unavailable:",
      error instanceof Error ? error.message : String(error)
    );
    return null;
  }
}
