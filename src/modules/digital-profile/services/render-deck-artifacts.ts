/**
 * Deck render adapter for the canonical prepare stage.
 *
 * The DEFAULT adapter drives the EXISTING local python renderer (the same one
 * the report-72 replay uses) — there is no second renderer. It is injectable so
 * offline orchestration tests can substitute a lightweight adapter while still
 * asserting "exactly one render per completed job".
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

/**
 * Render through the existing local python renderer. Requires `python` on PATH
 * with the project renderer deps. Never calls the network.
 */
export const renderDeckWithPython: DeckRenderAdapter = async (input) => {
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

  execFileSync(
    "python",
    ["scripts/render-orion-golden-artifacts.py", payloadPath, pptxPath, pdfPath, pagesDir],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }
  );

  const contactSheet = join(input.outputRoot, "contact-sheet.png");
  try {
    execFileSync(
      "python",
      ["-X", "utf8", "scripts/build-contact-sheet.py", pagesDir, contactSheet],
      { cwd: process.cwd(), encoding: "utf8" }
    );
  } catch {
    // contact sheet is a diagnostic aid; render itself already succeeded.
  }

  const pngPages = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length
    : 0;

  return {
    pdf: existsSync(pdfPath) ? pdfPath : undefined,
    pptx: existsSync(pptxPath) ? pptxPath : undefined,
    pngDir: existsSync(pagesDir) ? pagesDir : undefined,
    contactSheet: existsSync(contactSheet) ? contactSheet : undefined,
    pageCount: pngPages,
    renderer: "python:render-orion-golden-artifacts",
  };
};
