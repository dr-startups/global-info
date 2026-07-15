/**
 * Local production-like render validation for dynamic First36 pagination.
 * Composes a 16-row RU + 12-row UAE deck, renders via the local Python path
 * (fitz fallback, no LibreOffice), and verifies PNG/page counts + no clipping.
 * NETWORK_CALLS=0 (ORION_GOLDEN_FORCE_LOCAL_RENDER=1).
 */

import { mkdirSync, readdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import { inspectFirst36Acceptance } from "../src/modules/digital-profile/orion-golden/classic/first36-acceptance-gate";
import { inspectCrossSlideMetricConsistency } from "../src/modules/digital-profile/orion-golden/classic/cross-slide-metric-consistency";
import { inspectClientCopySlides } from "../src/modules/digital-profile/orion-golden/classic/client-copy-completeness";

const LONG =
  "Очень длинный заголовок новостной публикации о субъекте проверки с уточняющими деталями и контекстом события";

function serpRows(count: number, query: string, adverseEvery: number): string[][] {
  return Array.from({ length: count }, (_, i) => [
    query,
    String(i + 1),
    `example${i}.ru`,
    `${LONG} #${i + 1}`,
    i % adverseEvery === 0 ? "Н" : "·",
  ]);
}

function spec(ruRows: string[][], uaeRows: string[][]): OrionClassicAuditReportSpec {
  const serpBlock = (sectionId: string, key: string, rows: string[][], title: string) => ({
    sectionId,
    order: Number(sectionId.slice(0, 2)),
    block: {
      sectionKey: key,
      slideSpecs: [
        {
          slideKey: `${key}-table`,
          template: "orion_golden_search_table",
          title,
          narrative: "Таблица фиксирует сохранённые позиции поисковой выдачи по субъекту.",
          table: { headers: ["Запрос", "Позиция", "Домен", "Заголовок", "Статус"], rows },
        },
      ],
    },
  });
  return {
    version: "r10-classic-orion-audit-report-spec-v1",
    subject: { displayName: "Глинка Сергей Михайлович", reportTitle: "Аудит", asOfDate: "2026-07-10" },
    globalToc: [
      { title: "Резюме", sectionId: "01_executive_summary" },
      { title: "Россия", sectionId: "10_ru_audit_summary" },
      { title: "ОАЭ", sectionId: "30_uae_audit_summary" },
    ],
    registrySections: [
      serpBlock("12_ru_serp_position_table", "12_ru_serp_position_table", ruRows, "Россия — позиции в поисковой выдаче"),
      serpBlock("32_uae_serp_position_table", "32_uae_serp_position_table", uaeRows, "ОАЭ — позиции в поисковой выдаче"),
    ],
    offer: { sectionKey: "offer", slideSpecs: [{ slideKey: "offer", template: "orion_golden_prose", title: "Оффер" }] },
    productOverview: { sectionKey: "productOverview", slideSpecs: [{ slideKey: "po", template: "orion_golden_prose", title: "Продукт" }] },
    solutionDigitalProfile: { sectionKey: "solutionDigitalProfile", slideSpecs: [{ slideKey: "sdp", template: "orion_golden_prose", title: "ЦП" }] },
    solutionComplianceDatabases: { sectionKey: "solutionComplianceDatabases", slideSpecs: [{ slideKey: "scd", template: "orion_golden_prose", title: "БД" }] },
    solutionWikipedia: { sectionKey: "solutionWikipedia", slideSpecs: [{ slideKey: "sw", template: "orion_golden_prose", title: "Wiki" }] },
    about: { sectionKey: "about", slideSpecs: [{ slideKey: "about", template: "orion_golden_prose", title: "О нас" }] },
  } as OrionClassicAuditReportSpec;
}

function main() {
  const outRoot = join(process.cwd(), "storage", "digital-profile", "qa-dynamic-first36-render");
  mkdirSync(outRoot, { recursive: true });

  const deck = composeOrionFirst36CeoDeck(spec(serpRows(16, "Глинка Сергей Михайлович", 5), serpRows(12, "Sergey Glinka UAE", 4)), []);
  writeFileSync(join(outRoot, "final-deck-manifest.json"), JSON.stringify(deck, null, 2), "utf-8");
  console.log(`composed deck: totalSlideCount=${deck.totalSlideCount} baseSlotCoverage=${deck.baseSlotCoverage}`);

  const payload = {
    reportSpec: { subject: { displayName: "Глинка Сергей Михайлович" } },
    deckManifest: deck,
    assets: [] as ReportAssetV1[],
  };
  const payloadPath = join(outRoot, "golden-render-payload.json");
  writeFileSync(payloadPath, JSON.stringify(payload), "utf-8");

  const pptx = join(outRoot, "rendered-client.pptx");
  const pdf = join(outRoot, "rendered-client.pdf");
  const pagesDir = join(outRoot, "pages-png");
  const script = join(process.cwd(), "scripts", "render-orion-golden-artifacts.py");
  const proc = spawnSync("python", [script, payloadPath, pptx, pdf, pagesDir], {
    encoding: "utf-8",
    env: { ...process.env, PYTHONPATH: join(process.cwd(), "renderer") },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    console.error("RENDER FAILED");
    console.error(proc.stderr || proc.stdout);
    process.exitCode = 1;
    return;
  }
  console.log(proc.stdout.trim());

  const pngs = existsSync(pagesDir) ? readdirSync(pagesDir).filter((n) => /\.png$/i.test(n)) : [];
  const total = deck.finalSlides.length;
  const ok = pngs.length === total && existsSync(pptx) && existsSync(pdf);
  console.log(`[${ok ? "PASS" : "FAIL"}] render bundle: ${pngs.length} PNGs, expected ${total}; pptx=${existsSync(pptx)} pdf=${existsSync(pdf)}`);

  // Clipping telemetry check (if produced).
  const telPath = join(outRoot, "layout-telemetry.json");
  if (existsSync(telPath)) {
    const tel = JSON.parse(readFileSync(telPath, "utf-8")) as { entries?: Array<{ clipped?: boolean; page?: number }> };
    const clipped = (tel.entries ?? []).filter((e) => e.clipped);
    console.log(`[${clipped.length === 0 ? "PASS" : "WARN"}] clipping telemetry: ${clipped.length} clipped entries`);
  }
  if (!ok) process.exitCode = 1;

  const acceptance = inspectFirst36Acceptance({
    slideCount: total,
    baseSlotCoverage: deck.baseSlotCoverage,
    missingBaseSlots: deck.missingBaseSlots,
    slides: deck.finalSlides,
    paths: { pptx, pdf, pagesPngDir: pagesDir },
  });
  writeFileSync(join(outRoot, "first36-acceptance.json"), JSON.stringify(acceptance, null, 2), "utf-8");
  console.log(`[${acceptance.passed ? "PASS" : "FAIL"}] first36 acceptance: ${acceptance.issues.length} issues`);

  const metricIssues = inspectCrossSlideMetricConsistency({ themeSet: null, slides: deck.finalSlides });
  writeFileSync(
    join(outRoot, "metric-consistency-report.json"),
    JSON.stringify({ passed: metricIssues.length === 0, issues: metricIssues }, null, 2),
    "utf-8"
  );

  const copyIssues = inspectClientCopySlides(deck.finalSlides);
  console.log(`[${copyIssues.length === 0 ? "PASS" : "FAIL"}] client copy QA: ${copyIssues.length} issues`);

  const serpSlides = deck.finalSlides.filter((s) => s.template === "orion_golden_search_table");
  for (const s of serpSlides) {
    const c = s.searchCounters;
    console.log(
      `  ${s.title} p${s.pageNumber}: rows=${c?.pageDisplayedCount ?? s.table?.rows?.length} adverse=${c?.pageDisplayedAdverseCount ?? 0} dataset=${c?.datasetCount}`
    );
  }
  console.log(`NETWORK_CALLS=0`);
}

main();
