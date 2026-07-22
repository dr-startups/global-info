/**
 * Stage 6 characterization — wire composed summary into EXECUTIVE_SUMMARY,
 * assert semantic pagination gates, optionally render summary pages + contact sheet.
 *
 * NETWORK_CALLS=0. No live API.
 *
 * Usage:
 *   npx tsx scripts/characterize-semantic-summary-pagination.ts <analyticsDir> [outDir]
 *   SKIP_RENDER=1 to skip PPTX/PDF/PNG
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadDeckInputsFromAnalyticsDir } from "../src/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import { runDeckBuild, toRendererPayload } from "../src/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { ComposedClientSummarySchema } from "../src/modules/digital-profile/orion-golden/contracts/composed-client-summary";
import {
  assertSemanticSummaryGatesPass,
  paginateComposedClientSummary,
} from "../src/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";
import type { ComposedClientSummary } from "../src/modules/digital-profile/orion-golden/contracts/composed-client-summary";

process.env.NETWORK_CALLS = "0";

/** Prefer repo font when ORION_RENDER_FONT is unset (Windows packages lack /usr path). */
function ensureRenderFontEnv(): void {
  if (process.env.ORION_RENDER_FONT) return;
  const candidate = join(process.cwd(), "renderer", "fonts", "DejaVuSans.ttf");
  if (existsSync(candidate)) process.env.ORION_RENDER_FONT = candidate;
}

function main(): void {
  ensureRenderFontEnv();
  const analyticsDir = process.argv[2];
  if (!analyticsDir) {
    console.error(
      "Usage: npx tsx scripts/characterize-semantic-summary-pagination.ts <analyticsDir> [outDir]"
    );
    process.exit(2);
  }
  const outDir = process.argv[3] ?? join(analyticsDir, "..", "stage6-summary-pagination");
  mkdirSync(outDir, { recursive: true });

  const composedPath = join(analyticsDir, "composed-client-summary.json");
  if (!existsSync(composedPath)) {
    console.error(`missing ${composedPath} — run Stage 5 characterize first`);
    process.exit(1);
  }
  const composed = ComposedClientSummarySchema.parse(
    JSON.parse(readFileSync(composedPath, "utf8"))
  ) as ComposedClientSummary;
  const plan = paginateComposedClientSummary(composed, { leadThemeCount: 3 });
  assertSemanticSummaryGatesPass(plan);

  const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir);
  if (!inputs.composedClientSummary) {
    console.error("loadDeckInputs did not pick up composed-client-summary.json");
    process.exit(1);
  }

  const subjectName =
    typeof (inputs.executiveSummary as { /* loose */ }).executiveConclusion === "string"
      ? String(
          (composed.subjectId || "subject").split(/\s+/u)[0] ?? "subject"
        )
      : composed.subjectId;

  const deckOut = join(outDir, "deck");
  mkdirSync(deckOut, { recursive: true });
  const result = runDeckBuild({
    ctx: {
      caseId: inputs.caseId,
      reportRunId: inputs.reportRunId,
      sourceDatasetId: inputs.sourceDatasetId,
      contentVersion: "deck-sections-v38-stage6",
      subject: { displayName: composed.subjectId, aliases: [] },
      bundle: inputs.mergedBundle,
      surfaceUnits: inputs.surfaceUnits,
      metricSnapshot: inputs.metricSnapshot,
      evidenceIndex: inputs.evidenceIndex,
      extras: {
        executiveSummary: inputs.executiveSummary as never,
        composedClientSummary: composed,
        uncategorizedMaterials: inputs.uncategorizedMaterials ?? undefined,
        surfaceCollectionHints: inputs.surfaceCollectionHints,
      },
    },
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot: deckOut,
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
  });

  const execPack = result.packs.find((p) => p.fragmentKey === "EXECUTIVE_SUMMARY");
  if (!execPack) {
    console.error("EXECUTIVE_SUMMARY pack missing");
    process.exit(1);
  }

  const contSlides = execPack.slides.filter((s) => s.isContinuation);
  const baseSlide = execPack.slides.find((s) => !s.isContinuation);
  let adjacency = Boolean(baseSlide);
  for (let i = 0; i < execPack.slides.length; i += 1) {
    const s = execPack.slides[i]!;
    if (!s.isContinuation) continue;
    const prev = execPack.slides[i - 1]!;
    if (
      !prev ||
      (prev.slideId !== s.continuationOf && prev.continuationOf !== s.continuationOf)
    ) {
      adjacency = false;
    }
  }

  const truncations = Number(baseSlide?.metrics?.CLIENT_TEXT_TRUNCATIONS ?? -1);
  const incompleteSentenceHits: string[] = [];
  for (const s of execPack.slides) {
    for (const t of [s.content.narrative ?? "", ...(s.content.bullets ?? [])]) {
      for (const para of t.split("\n")) {
        const p = para.trim();
        if (!p) continue;
        if (/\s(?:и|в|во|на|по|с|со|о|об|and|or|of|the|to)\s*$/iu.test(p)) {
          incompleteSentenceHits.push(p.slice(0, 80));
        }
      }
    }
  }

  // TOC: flag repeated "(N стр.)" on every line (Stage 6 test).
  const tocSlide = result.assembly.rendererSlides.find((s) =>
    /содержание|оглавление/i.test(s.title ?? "")
  );
  const tocText = [
    tocSlide?.narrative ?? "",
    ...(tocSlide?.bullets ?? []),
  ].join("\n");
  const tocLines = tocText.split("\n").map((l) => l.trim()).filter(Boolean);
  const tocPageSuffixCount = tocLines.filter((l) => /\(\d+\s*стр\.?\)/u.test(l)).length;
  const tocRepeatsPageSuffixOnEveryLine =
    tocLines.length > 0 && tocPageSuffixCount === tocLines.length;

  let geometryIssues = -1;
  let pageParity = false;
  let summaryPngCount = 0;
  let renderSkipped = process.env.SKIP_RENDER === "1";

  if (!renderSkipped && result.assembly.errors.length === 0) {
    const payload = toRendererPayload({
      deckManifest: result.assembly.deckManifest,
      rendererSlides: result.assembly.rendererSlides,
      subjectName: composed.subjectId || subjectName,
      assets: [],
    });
    const payloadPath = join(outDir, "render-payload.json");
    const pptxPath = join(outDir, "rendered-client.pptx");
    const pdfPath = join(outDir, "rendered-client.pdf");
    const pagesDir = join(outDir, "pages-png");
    if (existsSync(pagesDir)) rmSync(pagesDir, { recursive: true, force: true });
    writeFileSync(payloadPath, JSON.stringify(payload), "utf8");
    try {
      execFileSync(
        "python",
        ["scripts/render-orion-golden-artifacts.py", payloadPath, pptxPath, pdfPath, pagesDir],
        { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }
      );
      const pngFiles = existsSync(pagesDir)
        ? readdirSync(pagesDir).filter((f) => f.endsWith(".png")).sort()
        : [];
      const pptxPages = result.assembly.deckManifest.pageCount;
      pageParity =
        pngFiles.length === pptxPages &&
        existsSync(pdfPath) &&
        existsSync(pptxPath);

      // Geometry inspector (existing).
      try {
        const geometryJson = execFileSync(
          "python",
          ["-X", "utf8", "scripts/inspect-first36-pptx-geometry.py", pptxPath],
          { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
        );
        writeFileSync(join(outDir, "geometry-report.json"), geometryJson, "utf8");
        const geometry = JSON.parse(geometryJson) as {
          overlaps?: unknown[];
          overflow?: unknown[];
          clipping?: unknown[];
          empty?: unknown[];
        };
        geometryIssues =
          (geometry.overlaps?.length ?? 0) +
          (geometry.overflow?.length ?? 0) +
          (geometry.clipping?.length ?? 0) +
          (geometry.empty?.length ?? 0);
      } catch (e) {
        writeFileSync(
          join(outDir, "geometry-inspect-error.txt"),
          String(e),
          "utf8"
        );
      }

      // Copy executive/summary pages into a dedicated folder + contact sheet.
      const summaryDir = join(outDir, "summary-pages-png");
      mkdirSync(summaryDir, { recursive: true });
      const execSlideKeys = new Set(
        result.assembly.deckManifest.slides
          .filter((s) => s.sectionType === "EXECUTIVE" || /executive|резюме/i.test(s.title))
          .map((s) => s.pageNumber)
      );
      // Prefer slides from EXECUTIVE_SUMMARY pack page numbers via deck manifest.
      const execPages = result.assembly.deckManifest.slides
        .filter((s) => {
          const packSlide = execPack.slides.find((ps) => ps.slideId === s.slideId);
          return Boolean(packSlide);
        })
        .map((s) => s.pageNumber);
      const pageSet = new Set(execPages.length ? execPages : [...execSlideKeys]);
      for (const n of pageSet) {
        const name = `page-${String(n).padStart(2, "0")}.png`;
        const alt = readdirSync(pagesDir).find((f) =>
          new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(f)
        );
        const src = existsSync(join(pagesDir, name))
          ? join(pagesDir, name)
          : alt
            ? join(pagesDir, alt)
            : null;
        if (src) {
          copyFileSync(src, join(summaryDir, `summary-${String(n).padStart(2, "0")}.png`));
          summaryPngCount += 1;
        }
      }
      if (summaryPngCount > 0) {
        try {
          execFileSync(
            "python",
            [
              "-X",
              "utf8",
              "scripts/build-contact-sheet.py",
              summaryDir,
              join(outDir, "summary-contact-sheet.png"),
            ],
            { cwd: process.cwd(), encoding: "utf8" }
          );
        } catch (e) {
          writeFileSync(join(outDir, "contact-sheet-error.txt"), String(e), "utf8");
        }
      }
    } catch (e) {
      renderSkipped = true;
      writeFileSync(join(outDir, "render-error.txt"), String(e), "utf8");
    }
  }

  const report = {
    schemaVersion: "semantic-summary-pagination-characterization-v1",
    caseId: composed.caseId,
    subjectId: composed.subjectId,
    planGates: plan.gates,
    executiveSlides: execPack.slides.length,
    continuationCount: contSlides.length,
    CONTINUATION_ADJACENCY: adjacency,
    CLIENT_TEXT_TRUNCATIONS: truncations,
    incompleteSentenceHits: incompleteSentenceHits.slice(0, 10),
    tocRepeatsPageSuffixOnEveryLine,
    GEOMETRY_ISSUES: geometryIssues,
    PDF_PPTX_PNG_PAGE_PARITY: pageParity,
    summaryPngCount,
    renderSkipped,
    execPackQaPassed: execPack.validation.passed,
    assemblyContinuationAdjacency:
      result.assemblyValidation?.checks.continuationAdjacency ?? null,
    overviewHeadings: plan.overviewBlocks.map((b) => b.heading ?? b.blockId),
    continuationPageBlockCounts: plan.continuationPages.map((p) => p.length),
    artifacts: {
      outDir,
      executiveSummaryPack: join(deckOut, "section-packs/executive/summary.json"),
      report: join(outDir, "semantic-summary-pagination-characterization-report.json"),
    },
  };

  writeFileSync(
    join(outDir, "semantic-summary-pagination-characterization-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  writeFileSync(
    join(outDir, "executive-summary-slides.json"),
    `${JSON.stringify(execPack.slides, null, 2)}\n`,
    "utf8"
  );

  const stopOk =
    report.CLIENT_TEXT_TRUNCATIONS === 0 &&
    report.CONTINUATION_ADJACENCY === true &&
    (report.GEOMETRY_ISSUES === 0 || report.renderSkipped) &&
    (report.PDF_PPTX_PNG_PAGE_PARITY === true || report.renderSkipped);

  console.log(
    JSON.stringify(
      {
        ok: stopOk,
        CLIENT_TEXT_TRUNCATIONS: report.CLIENT_TEXT_TRUNCATIONS,
        CONTINUATION_ADJACENCY: report.CONTINUATION_ADJACENCY,
        GEOMETRY_ISSUES: report.GEOMETRY_ISSUES,
        PDF_PPTX_PNG_PAGE_PARITY: report.PDF_PPTX_PNG_PAGE_PARITY,
        executiveSlides: report.executiveSlides,
        summaryPngCount: report.summaryPngCount,
        renderSkipped: report.renderSkipped,
        outDir,
      },
      null,
      2
    )
  );
  if (!stopOk && !report.renderSkipped) process.exit(1);
}

main();
