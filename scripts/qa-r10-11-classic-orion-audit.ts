/**
 * R10.11 — Smoke: classic ORION audit render from post-review client content.
 *
 * Usage:
 *   npx tsx scripts/qa-r10-11-classic-orion-audit.ts [caseId]
 *   npx tsx scripts/qa-r10-11-classic-orion-audit.ts --offline
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrionClientContent } from "../src/modules/digital-profile/orion-golden/content/orion-client-content-builder";
import type { FullEvidenceInventory } from "../src/modules/digital-profile/orion-golden/evidence/full-evidence-inventory";
import { buildOrionClassicReportSpecFromClientContent } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import { composeOrionClassicAuditDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-deck-composer";
import { inspectClassicOrionAuditQuality } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-quality-inspection";
import { runOrionClassicAuditRender } from "../src/modules/digital-profile/orion-golden/classic/run-orion-classic-audit-render";

const offline = process.argv.includes("--offline");
const caseId = process.argv.find((a) => !a.startsWith("-")) ?? "cmqzz1vbr00d2vdrsrjsgie2g";
const outputRoot = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r10-11-classic-orion-audit",
  caseId,
  String(Date.now())
);

function runOfflineComposition(): void {
  const root = join(process.cwd(), "storage", "digital-profile", "qa-r10-7-real-subject-calibration");
  const clientPath = join(root, "orion-client-content.post-review.json");
  const inventoryPath = join(root, "full-evidence-inventory.json");
  if (!existsSync(clientPath) || !existsSync(inventoryPath)) {
    throw new Error("offline-artifacts-missing");
  }
  const clientContent = JSON.parse(readFileSync(clientPath, "utf-8")) as OrionClientContent;
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf-8")) as FullEvidenceInventory;
  const reportSpec = buildOrionClassicReportSpecFromClientContent({
    clientContent,
    inventory,
    assets: [],
    inventoryCounts: inventory.counts,
  });
  const deckManifest = composeOrionClassicAuditDeck(reportSpec, []);
  const qa = inspectClassicOrionAuditQuality({
    deckManifest,
    reportSpec,
    inventory,
    outputRoot,
  });
  const result = {
    mode: "offline-composition",
    slideCount: deckManifest.slideCount,
    registrySections: reportSpec.registrySections.length,
    commercialSlides: deckManifest.finalSlides.filter((s) =>
      ["offer", "product_overview", "solution_digital_profile", "about"].includes(s.sectionKey)
    ).length,
    classicQaPassed: qa.passed,
    issues: qa.issues,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!qa.passed) process.exitCode = 1;
}

async function main(): Promise<void> {
  process.env.ORION_CLASSIC_AUDIT_MODE = "1";
  if (offline) {
    runOfflineComposition();
    return;
  }
  const result = await runOrionClassicAuditRender({ caseId, outputRoot });
  console.log(JSON.stringify(result, null, 2));
  if (result.verdict !== "PASS") {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
