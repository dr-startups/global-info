/**
 * Deck render adapter for the canonical prepare stage.
 *
 * Production/staging: HTTP to the existing Railway renderer `/orion/render-golden`
 * (same payload shape as local python / toRendererPayload). No silent fallback
 * to local spawn when an explicit renderer URL is configured.
 *
 * Local python spawn is opt-in only (ORION_CANONICAL_ALLOW_LOCAL_RENDER=1 or
 * ORION_GOLDEN_FORCE_LOCAL_RENDER=1) and is refused when HTTP URL is set.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  toRendererPayload,
  type RendererAssetEntry,
} from "../orion-golden/deck-sections/run-deck-build";
import type { ReportDeckManifest } from "../orion-golden/deck-sections/contracts";
import type { RendererSlide } from "../orion-golden/deck-sections/deck-assembler";
import { digitalProfileConfig } from "../config";

export type DeckRenderInput = {
  deckManifest: ReportDeckManifest;
  rendererSlides: RendererSlide[];
  subjectName: string;
  assets?: RendererAssetEntry[];
  /** Where PPTX/PDF/PNG/contact-sheet are written (job-scoped). */
  outputRoot: string;
};

export type DeckRenderResult = {
  pdf?: string;
  pptx?: string;
  pngDir?: string;
  contactSheet?: string;
  pageCount: number;
  renderer: string;
};

export type DeckRenderAdapter = (input: DeckRenderInput) => Promise<DeckRenderResult>;

type GoldenHttpResult = {
  slideCount: number;
  pptxBase64: string;
  pdfBase64: string;
  pages?: Array<{ pageNumber: number; contentBase64: string }>;
  pdfExportMode?: string;
  warnings?: string[];
};

/** True when RENDERER_URL / DIGITAL_PROFILE_RENDERER_URL is explicitly set. */
export function isExplicitHttpRendererConfigured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return Boolean(
    String(env.RENDERER_URL ?? "").trim() ||
      String(env.DIGITAL_PROFILE_RENDERER_URL ?? "").trim()
  );
}

/** Opt-in local python only — never used when HTTP renderer URL is configured. */
export function isLocalPythonRenderAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isExplicitHttpRendererConfigured(env)) return false;
  const force =
    env.ORION_CANONICAL_ALLOW_LOCAL_RENDER === "1" ||
    env.ORION_GOLDEN_FORCE_LOCAL_RENDER === "1";
  return force;
}

/** Strip URLs, storage keys, and absolute paths from client-facing errors. */
export function sanitizeRendererClientError(message: string): string {
  let out = String(message ?? "");
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, "[renderer]");
  out = out.replace(/\bstorageKey[=:]\s*[^\s,;]+/gi, "storageKey=[redacted]");
  out = out.replace(/[A-Za-z]:\\[^\s"'<>]+/g, "[path]");
  out = out.replace(/\/(?:app|var|tmp|home|Users)\/[^\s"'<>]+/g, "[path]");
  if (/ENOENT|spawnSync|spawn\s+python|python.*not found/i.test(out)) {
    return "Renderer service unavailable";
  }
  return out.slice(0, 240);
}

function writePayload(input: DeckRenderInput): {
  payload: Record<string, unknown>;
  payloadPath: string;
  pptxPath: string;
  pdfPath: string;
  pagesDir: string;
} {
  mkdirSync(input.outputRoot, { recursive: true });
  const payload = toRendererPayload({
    deckManifest: input.deckManifest,
    rendererSlides: input.rendererSlides,
    subjectName: input.subjectName,
    assets: input.assets,
  });
  const payloadPath = join(input.outputRoot, "render-payload.json");
  writeFileSync(payloadPath, JSON.stringify(payload), "utf8");
  const pptxPath = join(input.outputRoot, "rendered-client.pptx");
  const pdfPath = join(input.outputRoot, "rendered-client.pdf");
  const pagesDir = join(input.outputRoot, "pages-png");
  if (existsSync(pagesDir)) rmSync(pagesDir, { recursive: true, force: true });
  mkdirSync(pagesDir, { recursive: true });
  return { payload, payloadPath, pptxPath, pdfPath, pagesDir };
}

function finishFromFiles(
  pptxPath: string,
  pdfPath: string,
  pagesDir: string,
  renderer: string
): DeckRenderResult {
  const contactSheet = join(pagesDir, "..", "contact-sheet.png");
  const pngPages = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length
    : 0;
  if (!existsSync(pptxPath) && !existsSync(pdfPath)) {
    throw new Error("renderer returned no PPTX/PDF artifacts");
  }
  return {
    pdf: existsSync(pdfPath) ? pdfPath : undefined,
    pptx: existsSync(pptxPath) ? pptxPath : undefined,
    pngDir: existsSync(pagesDir) ? pagesDir : undefined,
    contactSheet: existsSync(contactSheet) ? contactSheet : undefined,
    pageCount: pngPages,
    renderer,
  };
}

/**
 * HTTP render via existing `/orion/render-golden`. Injectible fetch for offline tests.
 */
export async function renderDeckViaHttp(
  input: DeckRenderInput,
  deps?: { fetchImpl?: typeof fetch; rendererBaseUrl?: string }
): Promise<DeckRenderResult> {
  const { payload, pptxPath, pdfPath, pagesDir } = writePayload(input);
  const base = String(deps?.rendererBaseUrl ?? digitalProfileConfig.rendererUrl)
    .trim()
    .replace(/\/$/, "");
  if (!base) {
    throw new Error("HTTP renderer URL is not configured");
  }
  const url = `${base}/orion/render-golden`;
  const fetchImpl = deps?.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (err) {
    throw new Error(
      sanitizeRendererClientError(
        `HTTP renderer unreachable: ${err instanceof Error ? err.message : String(err)}`
      )
    );
  }
  if (!res.ok) {
    const body = sanitizeRendererClientError((await res.text().catch(() => "")).slice(0, 200));
    throw new Error(`HTTP renderer failed (${res.status})${body ? `: ${body}` : ""}`);
  }
  const json = (await res.json()) as GoldenHttpResult;
  if (!json.pptxBase64 && !json.pdfBase64) {
    throw new Error("HTTP renderer returned empty artifacts");
  }
  if (json.pptxBase64) {
    writeFileSync(pptxPath, Buffer.from(json.pptxBase64, "base64"));
  }
  if (json.pdfBase64) {
    writeFileSync(pdfPath, Buffer.from(json.pdfBase64, "base64"));
  }
  for (const page of json.pages ?? []) {
    writeFileSync(
      join(pagesDir, `page-${String(page.pageNumber).padStart(2, "0")}.png`),
      Buffer.from(page.contentBase64, "base64")
    );
  }
  writeFileSync(
    join(input.outputRoot, "golden-render-meta.json"),
    JSON.stringify(
      {
        pdfExportMode: json.pdfExportMode ?? "unknown",
        slideCount: json.slideCount,
        warnings: json.warnings ?? [],
        via: "http",
      },
      null,
      2
    ),
    "utf8"
  );
  return finishFromFiles(pptxPath, pdfPath, pagesDir, "http:orion/render-golden");
}

/**
 * Local python spawn — opt-in only. Never call when HTTP URL is configured.
 */
export const renderDeckWithPython: DeckRenderAdapter = async (input) => {
  if (isExplicitHttpRendererConfigured()) {
    throw new Error(
      "local python render refused: explicit HTTP renderer URL is configured (no silent fallback)"
    );
  }
  const { payloadPath, pptxPath, pdfPath, pagesDir } = writePayload(input);
  try {
    execFileSync(
      "python",
      ["scripts/render-orion-golden-artifacts.py", payloadPath, pptxPath, pdfPath, pagesDir],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }
    );
  } catch (err) {
    throw new Error(
      sanitizeRendererClientError(err instanceof Error ? err.message : String(err))
    );
  }
  const contactSheet = join(input.outputRoot, "contact-sheet.png");
  try {
    execFileSync(
      "python",
      ["-X", "utf8", "scripts/build-contact-sheet.py", pagesDir, contactSheet],
      { cwd: process.cwd(), encoding: "utf8" }
    );
  } catch {
    // contact sheet is diagnostic only
  }
  return finishFromFiles(pptxPath, pdfPath, pagesDir, "python:render-orion-golden-artifacts");
};

export type CanonicalRenderDeps = {
  fetchImpl?: typeof fetch;
  rendererBaseUrl?: string;
};

/**
 * Default canonical adapter: HTTP when URL configured; else opt-in local python.
 * Never falls back from HTTP failure to local spawn.
 */
export function createCanonicalDeckRenderAdapter(
  deps: CanonicalRenderDeps = {}
): DeckRenderAdapter {
  return async (input) => {
    if (isExplicitHttpRendererConfigured() || deps.rendererBaseUrl) {
      return renderDeckViaHttp(input, deps);
    }
    if (isLocalPythonRenderAllowed()) {
      return renderDeckWithPython(input);
    }
    throw new Error(
      "Renderer not configured: set DIGITAL_PROFILE_RENDERER_URL (or RENDERER_URL), " +
        "or ORION_CANONICAL_ALLOW_LOCAL_RENDER=1 for explicit local python"
    );
  };
}

/** Production default used by canonical prepare when no adapter is injected. */
export const renderCanonicalDeck: DeckRenderAdapter = createCanonicalDeckRenderAdapter();
