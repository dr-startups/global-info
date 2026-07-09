/**
 * R10.9 — Render PDF/PPTX from existing post-review client content artifacts.
 * Avoids re-running full GPT brain when calibration artifacts already exist.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";

function bootstrapEnv(): void {
  if (process.env.R10_DOCKER_NETWORK === "1") {
    process.env.RENDERER_URL = "http://renderer:8080";
  } else {
    process.env.RENDERER_URL ??= "http://localhost:8080";
  }
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const parsed = parse(readFileSync(envPath));
    for (const key of ["OPENAI_API_KEY", "DIGITAL_PROFILE_ORION_GOLDEN_ENABLED", "RENDERER_URL"] as const) {
      if (parsed[key] && !process.env[key]) process.env[key] = parsed[key];
    }
  }
  process.env.DIGITAL_PROFILE_ORION_GOLDEN_ENABLED ??= "true";
  process.env.R10_RENDER_FROM_CLIENT_CONTENT = "1";
  process.env.ORION_CLIENT_AUDIT_MODE = "1";
}

bootstrapEnv();

async function main() {
  const {
    buildOrionReportSpecFromClientContent,
  } = await import("../src/modules/digital-profile/orion-golden/report-spec/orion-client-content-to-report-spec");
  const { composeOrionClientAuditDeck } = await import(
    "../src/modules/digital-profile/orion-golden/composer/orion-client-audit-deck-composer"
  );
  const { renderOrionGoldenArtifacts } = await import(
    "../src/modules/digital-profile/orion-golden/renderer/orion-golden-render-client"
  );
  const { writeRendererIntegrationQaReport, inspectRendererIntegrationQa } = await import(
    "../src/modules/digital-profile/orion-golden/qa/r10-9-renderer-integration-qa"
  );
  const { writeClientRenderContentInspection, inspectClientRenderContent } = await import(
    "../src/modules/digital-profile/orion-golden/qa/r10-9-client-render-content-inspection"
  );

  const caseId = process.env.CASE_ID?.trim() || "cmqzz1vbr00d2vdrsrjsgie2g";
  const sourceRoot =
    process.env.R10_SOURCE_ARTIFACTS?.trim() ||
    join(process.cwd(), "storage", "digital-profile", "qa-r10-7-real-subject-calibration");
  const outputRoot =
    process.env.R10_OUTPUT_DIR?.trim() ||
    join(process.cwd(), "storage", "digital-profile", "qa-r10-9-renderer-integration");

  console.log(`[INFO] CASE_ID=${caseId}`);
  console.log(`[INFO] SOURCE=${sourceRoot}`);
  console.log(`[INFO] OUTPUT=${outputRoot}`);

  const postReviewPath = join(sourceRoot, "orion-client-content.post-review.json");
  if (!existsSync(postReviewPath)) {
    throw new Error(`missing post-review content: ${postReviewPath}`);
  }

  mkdirSync(outputRoot, { recursive: true });

  // Copy key content artifacts into R10.9 output
  for (const name of [
    "orion-client-content.post-review.json",
    "orion-client-content.post-review.md",
    "orion-client-content.pre-review.json",
    "risk-matrix.section-derived.json",
    "executive-synthesis.output.json",
    "full-evidence-inventory.json",
  ]) {
    const src = join(sourceRoot, name);
    if (existsSync(src)) cpSync(src, join(outputRoot, name));
  }

  const clientContent = JSON.parse(readFileSync(postReviewPath, "utf-8"));
  const executive = existsSync(join(sourceRoot, "executive-synthesis.output.json"))
    ? JSON.parse(readFileSync(join(sourceRoot, "executive-synthesis.output.json"), "utf-8"))
    : null;
  const riskMatrix = existsSync(join(sourceRoot, "risk-matrix.section-derived.json"))
    ? JSON.parse(readFileSync(join(sourceRoot, "risk-matrix.section-derived.json"), "utf-8"))
    : clientContent.riskMatrixSummary;
  const inventory = existsSync(join(sourceRoot, "full-evidence-inventory.json"))
    ? JSON.parse(readFileSync(join(sourceRoot, "full-evidence-inventory.json"), "utf-8"))
    : null;

  // Optional assets from parallel render if present
  let assets: unknown[] = [];
  const assetsCandidates = [
    join(sourceRoot, "report-assets.json"),
    join(process.cwd(), "storage/digital-profile/qa-r10-orion-golden-parallel/report-assets.json"),
  ];
  for (const p of assetsCandidates) {
    if (existsSync(p)) {
      assets = JSON.parse(readFileSync(p, "utf-8"));
      break;
    }
  }

  const reportSpec = buildOrionReportSpecFromClientContent({
    clientContent,
    executiveSynthesis: executive,
    riskMatrix,
    assets: assets as never[],
    inventoryCounts: inventory?.counts,
    warnings: inventory?.warnings ?? [],
  });
  writeFileSync(
    join(outputRoot, "orion-report-spec.from-client-content.json"),
    `${JSON.stringify(reportSpec, null, 2)}\n`,
    "utf-8"
  );
  writeFileSync(join(outputRoot, "orion-report-spec.json"), `${JSON.stringify(reportSpec, null, 2)}\n`, "utf-8");

  const deckManifest = composeOrionClientAuditDeck(reportSpec, assets as never[]);
  writeFileSync(
    join(outputRoot, "final-deck-manifest.json"),
    `${JSON.stringify(deckManifest, null, 2)}\n`,
    "utf-8"
  );

  console.log(`[INFO] slides=${deckManifest.slideCount} renderSource=client_content_adapter`);

  const renderResult = await renderOrionGoldenArtifacts({
    reportSpec,
    deckManifest,
    assets: assets as never[],
    pptxOut: join(outputRoot, "rendered-client.pptx"),
    pdfOut: join(outputRoot, "rendered-client.pdf"),
    pagesOut: join(outputRoot, "pages-png"),
  });
  console.log(`[INFO] render pdfExportMode=${renderResult.pdfExportMode} warnings=${renderResult.warnings.length}`);

  const contentInspection = inspectClientRenderContent({
    reportSpec,
    deckManifest,
    clientContentPath: join(outputRoot, "orion-client-content.post-review.json"),
  });
  writeClientRenderContentInspection(outputRoot, contentInspection);

  const qa = inspectRendererIntegrationQa({ outputRoot, reportSpec, deckManifest });
  writeRendererIntegrationQaReport(outputRoot, qa);

  const { writeVisualPolishQaArtifacts } = await import(
    "../src/modules/digital-profile/orion-golden/qa/r10-9a-visual-polish-qa"
  );
  const polish = writeVisualPolishQaArtifacts(outputRoot);

  console.log(`[INFO] contentVerdict=${contentInspection.verdict}`);
  console.log(`[INFO] integrationVerdict=${qa.verdict} pages=${qa.pageCount} pngs=${qa.pngCount}`);
  console.log(`[INFO] visualPolishVerdict=${polish.report.verdict}`);
  console.log(
    `[INFO] pageGrades PASS=${polish.report.pageReview.counts.PASS} MINOR=${polish.report.pageReview.counts.MINOR_ISSUE} MAJOR=${polish.report.pageReview.counts.MAJOR_ISSUE} BLOCKER=${polish.report.pageReview.counts.BLOCKER}`
  );
  console.log(`[INFO] pdfBytes=${qa.pdfBytes} pptxBytes=${qa.pptxBytes}`);

  if (!qa.passed || !polish.report.passed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
