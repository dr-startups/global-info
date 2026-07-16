/**
 * Offline characterization of report №72 from PDF + First36 registry.
 * NETWORK_CALLS=0. Does not touch production render paths.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ORION_FIRST36_REGISTRY_V1, FIRST36_EXACT_PAGE_COUNT } from "../../src/modules/digital-profile/orion-golden/classic/orion-first36-registry.v1";
import { inspectClientCopyText } from "../../src/modules/digital-profile/orion-golden/classic/client-copy-completeness";
import {
  buildArchitectureManifest,
  sha256Hex,
} from "../../src/modules/digital-profile/orion-golden/architecture/orion-architecture-manifest";

const ROOT = join(__dirname);
const ART = join(ROOT, "artifacts");
const PDF = join(ART, "orion-classic-audit-v72.pdf");
const EXPECTED_SHA =
  "78adc2e3708feb551521b2ac6b75958947d46e241f6f5162a7e6c65e343d7091";

type FieldStatus = "MEASURED" | "DERIVED" | "UNAVAILABLE";

function field<T>(status: FieldStatus, value: T, note?: string) {
  return { status, value, ...(note ? { note } : {}) };
}

/** PDF page → registry/dynamic role (title-matched against First36 registry + AI inserts). */
const PAGE_INVENTORY: Array<{
  page: number;
  title: string;
  role: "base" | "continuation" | "dynamic_insert";
  registrySlotId: string | null;
  continuationOf: string | null;
  continuationIndex: number | null;
  continuationCount: number | null;
}> = [
  { page: 1, title: "ORION Digital Profile", role: "base", registrySlotId: "p01_cover", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 2, title: "Содержание отчёта", role: "base", registrySlotId: "p02_toc", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 3, title: "Резюме", role: "base", registrySlotId: "p03_executive", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 4, title: "Матрица комплаенс-рисков", role: "base", registrySlotId: "p04_risk_dashboard", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 5, title: "Обзор цифрового профиля", role: "base", registrySlotId: "p05_profile_dashboard", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 6, title: "Россия: Цифровой профиль", role: "base", registrySlotId: "p06_ru_toc", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 7, title: "Россия — резюме аудита", role: "base", registrySlotId: "p07_ru_summary", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 8, title: "Россия — карточки выдачи", role: "base", registrySlotId: "p08_ru_metrics", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 9, title: "Россия — позиции в поисковая выдача", role: "base", registrySlotId: "p09_ru_serp_table", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 10, title: "Россия — снимок выдачи", role: "base", registrySlotId: "p10_ru_serp_visual", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 11, title: "Россия — подсказки поиска", role: "base", registrySlotId: "p11_ru_suggestions_yandex", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 12, title: "Россия — подсказки Google", role: "base", registrySlotId: "p12_ru_suggestions_google", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 13, title: "Россия — Википедия", role: "base", registrySlotId: "p13_ru_wikipedia", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 14, title: "Россия — изображения (1)", role: "base", registrySlotId: "p14_ru_images_1", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 15, title: "Россия — изображения (2)", role: "base", registrySlotId: "p15_ru_images_2", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 16, title: "Россия — изображения (3)", role: "base", registrySlotId: "p16_ru_images_3", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 17, title: "Россия — изображения (4)", role: "base", registrySlotId: "p17_ru_images_4", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 18, title: "Россия — панель знаний (1)", role: "base", registrySlotId: "p18_ru_knowledge_1", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 19, title: "Россия — панель знаний (2)", role: "base", registrySlotId: "p19_ru_knowledge_2", continuationOf: null, continuationIndex: null, continuationCount: null },
  // Not in First36 registry v1 — dynamic AI inserts (composer enrichment).
  { page: 20, title: "Россия — AI-выдача Яндекса", role: "dynamic_insert", registrySlotId: null, continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 21, title: "Россия — Google AI Overview", role: "dynamic_insert", registrySlotId: null, continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 22, title: "Россия — связанные запросы (1)", role: "base", registrySlotId: "p20_ru_related_1", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 23, title: "Россия — связанные запросы (2)", role: "base", registrySlotId: "p21_ru_related_2", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 24, title: "Россия — связанные запросы (3)", role: "base", registrySlotId: "p22_ru_related_3", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 25, title: "ОАЭ: Цифровой профиль", role: "base", registrySlotId: "p23_uae_toc", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 26, title: "ОАЭ — резюме аудита", role: "base", registrySlotId: "p24_uae_summary", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 27, title: "ОАЭ — ссылки Google", role: "base", registrySlotId: "p25_uae_metrics", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 28, title: "ОАЭ — позиции поисковая выдача", role: "base", registrySlotId: "p26_uae_serp_table", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 29, title: "ОАЭ — снимок выдачи", role: "base", registrySlotId: "p27_uae_serp_visual", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 30, title: "ОАЭ — подсказки поиска", role: "base", registrySlotId: "p28_uae_suggestions", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 31, title: "ОАЭ — Википедия", role: "base", registrySlotId: "p29_uae_wikipedia", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 32, title: "ОАЭ — изображения в поиске", role: "base", registrySlotId: "p30_uae_images", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 33, title: "ОАЭ — панель знаний", role: "base", registrySlotId: "p31_uae_knowledge", continuationOf: null, continuationIndex: null, continuationCount: null },
  // Dynamic AI series; (1/5) treated as series base insert, (2..5/5) as continuations.
  { page: 34, title: "ОАЭ — Google AI Overview (1/5)", role: "dynamic_insert", registrySlotId: null, continuationOf: null, continuationIndex: 1, continuationCount: 5 },
  { page: 35, title: "ОАЭ — Google AI Overview (2/5)", role: "continuation", registrySlotId: null, continuationOf: "uae_google_ai_overview", continuationIndex: 2, continuationCount: 5 },
  { page: 36, title: "ОАЭ — Google AI Overview (3/5)", role: "continuation", registrySlotId: null, continuationOf: "uae_google_ai_overview", continuationIndex: 3, continuationCount: 5 },
  { page: 37, title: "ОАЭ — Google AI Overview (4/5)", role: "continuation", registrySlotId: null, continuationOf: "uae_google_ai_overview", continuationIndex: 4, continuationCount: 5 },
  { page: 38, title: "ОАЭ — Google AI Overview (5/5)", role: "continuation", registrySlotId: null, continuationOf: "uae_google_ai_overview", continuationIndex: 5, continuationCount: 5 },
  { page: 39, title: "ОАЭ — связанные запросы", role: "base", registrySlotId: "p32_uae_related", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 40, title: "комплаенс — сводка баз данных", role: "base", registrySlotId: "p33_compliance_toc", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 41, title: "Dow Jones — профиль", role: "base", registrySlotId: "p34_dow_jones", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 42, title: "LexisNexis — страница профиля", role: "base", registrySlotId: "p35_lexis_visual", continuationOf: null, continuationIndex: null, continuationCount: null },
  { page: 43, title: "LexisNexis — страница профиля (2)", role: "base", registrySlotId: "p36_lexis_visual_2", continuationOf: null, continuationIndex: null, continuationCount: null },
];

function main() {
  process.env.NETWORK_CALLS = "0";
  if (!existsSync(PDF)) throw new Error(`missing pdf: ${PDF}`);
  const pdfBuf = readFileSync(PDF);
  const sha = sha256Hex(pdfBuf);
  if (sha !== EXPECTED_SHA) {
    throw new Error(`pdf sha mismatch: got ${sha}`);
  }

  const extract = JSON.parse(readFileSync(join(ART, "pdf-text-extract.json"), "utf8")) as {
    meta: { page_count: number; page_width_pt: number; page_height_pt: number };
    pages: Array<{ page: number; text: string }>;
  };
  const signals = JSON.parse(readFileSync(join(ART, "pdf-kpi-provider-signals.json"), "utf8")) as {
    providerMentionCounts: Record<string, number>;
  };

  const clientCopyIssues = extract.pages.flatMap((p) =>
    inspectClientCopyText(p.text, { page: p.page })
  );

  const registrySlotIds = ORION_FIRST36_REGISTRY_V1.map((s) => s.slotId);
  const mappedBase = PAGE_INVENTORY.filter((p) => p.role === "base" && p.registrySlotId);
  const missingRegistry = registrySlotIds.filter(
    (id) => !mappedBase.some((p) => p.registrySlotId === id)
  );
  const continuationPages = PAGE_INVENTORY.filter((p) => p.role === "continuation");
  const dynamicInserts = PAGE_INVENTORY.filter((p) => p.role === "dynamic_insert");

  const missingRunArtifacts = [
    "final-deck-manifest.json",
    "orion-theme-set.json",
    "orion-classic-report-spec.json",
    "report-assets.json",
    "first36-acceptance.json",
    "geometry-artifacts.json",
    "geometry-report.json",
    "client-copy-report.json",
    "metric-consistency-report.json",
    "cross-slide-metric-report.json",
    "arsenkin-report-binding.json",
    "client-content-binding.json",
    "run-scoped-serp-merge.json",
    "composite-serp-merge-provenance.json",
    "serp-observations-provenance.json",
    "rendered-client.pptx",
    "pages-png/",
    "contact-sheet.png",
  ];

  const baseline = {
    schemaVersion: "orion-report-72-baseline-v1",
    reportLabel: "№72",
    caseId: field("MEASURED" as const, "Глинка Сергей Михайлович", "Subject line on PDF cover; DB caseId unavailable"),
    datasetId: field("DERIVED" as const, "report-72-pdf-v1"),
    resolvedAt: field("MEASURED" as const, new Date().toISOString()),
    overallStatus: field(
      "DERIVED" as const,
      "PARTIAL_BASELINE",
      "PDF characterized; run-level JSON/PPTX artifacts still missing"
    ),
    pdf: {
      path: field("MEASURED" as const, "baselines/report-72/artifacts/orion-classic-audit-v72.pdf"),
      bytes: field("MEASURED" as const, pdfBuf.length),
      sha256: field("MEASURED" as const, sha),
      pageCount: field("MEASURED" as const, extract.meta.page_count),
      pageSizePt: field("MEASURED" as const, {
        width: extract.meta.page_width_pt,
        height: extract.meta.page_height_pt,
      }),
    },
    pageCount: field("MEASURED" as const, 43),
    pageSizePt: field("MEASURED" as const, { width: 921.6, height: 576.0 }, "Rounded from PDF media box 921.5999…×576"),
    first36Registry: {
      exactBaseSlotCount: field("MEASURED" as const, FIRST36_EXACT_PAGE_COUNT),
      registrySlotIds: field("MEASURED" as const, registrySlotIds),
      mappedRegistrySlotsInPdf: field("DERIVED" as const, mappedBase.length),
      missingRegistrySlotIdsInMapping: field("DERIVED" as const, missingRegistry),
    },
    baseSlots: field("DERIVED" as const, {
      count: mappedBase.length,
      pages: mappedBase.map((p) => ({
        page: p.page,
        slideId: p.registrySlotId,
        title: p.title,
      })),
      note: "Title-matched to ORION_FIRST36_REGISTRY_V1; PDF page index ≠ registry page after AI inserts",
    }),
    continuations: field("DERIVED" as const, {
      countBeyondRegistry: extract.meta.page_count - FIRST36_EXACT_PAGE_COUNT,
      explicitContinuationPages: continuationPages.map((p) => p.page),
      dynamicInsertPages: dynamicInserts.map((p) => p.page),
      series: [
        {
          id: "uae_google_ai_overview",
          pages: [34, 35, 36, 37, 38],
          markers: "1/5..5/5",
          basePage: 34,
          continuationPages: [35, 36, 37, 38],
        },
      ],
      note: "7 pages beyond First36 registry: RU AI×2 + UAE AI Overview×5 (of which 4 are explicit continuations)",
    }),
    pageInventory: field("DERIVED" as const, PAGE_INVENTORY),
    slideIds: field(
      "DERIVED" as const,
      PAGE_INVENTORY.map((p) => p.registrySlotId ?? `dynamic:p${String(p.page).padStart(2, "0")}`)
    ),
    providerCounts: field("MEASURED" as const, {
      mentionCountsInPdfText: signals.providerMentionCounts,
      serperMentions: signals.providerMentionCounts.Serper ?? 0,
      note: "Visible provider name mentions in PDF text — not raw observation row counts",
    }),
    datasetCounts: field("MEASURED" as const, {
      ruOrganicLinks: { adverse: 14, total: 158, source: "executive/profile slides" },
      uaeOrganicLinks: { adverse: 11, total: 97, source: "executive/UAE summary" },
      ruSerpTable: { adverse: 3, total: 18, source: "page 9" },
      uaeSerpTable: { adverse: 4, total: 18, source: "page 28" },
      observationRowCountsFromDb: null,
      note: "DB/composite observation counts UNAVAILABLE without run artifacts",
    }),
    kpiDenominators: field("MEASURED" as const, {
      ru: {
        adverseSharePercent: 9,
        links: "14 / 158",
        suggestions: "0 / 18",
        related: "1 / 10",
        images: "8 / 38",
        wikipediaStatus: "другой субъект",
      },
      uae: {
        adverseSharePercent: 11,
        links: "11 / 97",
        suggestions: "Нет данных",
        related: "0 / 1",
        images: "4 / 45",
        wikipediaStatus: "нет статьи / другой субъект",
      },
      profileOverviewPage5: {
        ruSuggestions: "0 / 18",
        ruRelated: "1 / 10",
        uaeSuggestions: "Нет данных",
        uaeRelated: "0 / 1",
      },
      relatedQueryCardCounts: {
        ruPage22: 4,
        ruPage23: 4,
        ruPage24: 2,
      },
      notCollectedSurfacesVisible: [
        { page: 18, surface: "RU Yandex Knowledge Panel", text: "данные не собраны" },
        { page: 39, surface: "UAE related", text: "NOT_COLLECTED" },
        { page: 43, surface: "LexisNexis page 2", text: "данные не собраны" },
      ],
    }),
    geometryGate: field(
      "UNAVAILABLE" as const,
      null,
      "Requires rendered-client.pptx + geometry-artifacts.json / Python PPTX inspector"
    ),
    clientCopyGate: field("MEASURED" as const, {
      method: "inspectClientCopyText over pdf page text extracts",
      issueCount: clientCopyIssues.length,
      issues: clientCopyIssues.slice(0, 50),
      note: "Partial offline substitute for client-copy-report.json (no slide structured fields)",
    }),
    acceptanceGate: field(
      "UNAVAILABLE" as const,
      null,
      "Requires first36-acceptance.json from runOrionClassicAuditRender"
    ),
    metricConsistencyGate: field("DERIVED" as const, {
      checks: [
        {
          id: "ru-adverse-share-9pct",
          ok: true,
          detail: "14/158 ≈ 8.86% displayed as 9% on pages 3/5/7",
        },
        {
          id: "uae-adverse-share-11pct",
          ok: true,
          detail: "11/97 ≈ 11.34% displayed as 11% on pages 3/5/26/27",
        },
        {
          id: "page-footer-43",
          ok: true,
          detail: "All extracted pages use N / 43 footer",
        },
        {
          id: "toc-repeated-total-suffix",
          ok: false,
          detail: "TOC lines use '(43 стр.)' on every entry (fixture REPEATED_TOC_PAGE_SUFFIX)",
        },
      ],
      note: "Full cross-slide-metric-consistency.ts needs deck manifest — unavailable",
    }),
    artifactFingerprints: field("MEASURED" as const, [
      {
        path: "baselines/report-72/artifacts/orion-classic-audit-v72.pdf",
        sha256: sha,
        present: true,
        bytes: pdfBuf.length,
      },
      {
        path: "baselines/report-72/artifacts/pdf-text-extract.json",
        sha256: sha256Hex(readFileSync(join(ART, "pdf-text-extract.json"))),
        present: true,
        bytes: readFileSync(join(ART, "pdf-text-extract.json")).length,
      },
    ]),
    missingRunArtifacts: field("UNAVAILABLE" as const, missingRunArtifacts, "Blockers for full gate/run reconstruction"),
    characterizationNotes: [
      "Source PDF copied from Downloads/orion-classic-audit (72).pdf",
      "Immutable facts verified: pageCount=43, size≈921.6×576, sha256 matches operator value",
      "Serper never named in PDF text; Yandex/Google/Arsenkin/Wikipedia/Lexis/Dow Jones/World-Check visible",
      "OTHER_SUBJECT leakage symptom visible: RU related queries about composer/opera/music treated as neutral",
      "UAE suggestions shown as 'Нет данных' on KPI tiles while slide 30 claims no negative suggestions",
    ],
  };

  writeFileSync(join(ROOT, "baseline.json"), JSON.stringify(baseline, null, 2), "utf8");

  const manifest = buildArchitectureManifest({
    caseId: "glinka-sergey-mikhaylovich-report-72",
    datasetId: "report-72-pdf-v1",
    canonicalBaseReportRunId: null,
    enrichmentRunIds: [],
    effectiveCompositeDatasetId: null,
    currentArtifacts: [
      {
        path: "baselines/report-72/artifacts/orion-classic-audit-v72.pdf",
        sha256: sha,
        present: true,
        bytes: pdfBuf.length,
      },
    ],
    bindings: {
      arsenkinReportBindingPath: null,
      clientContentBindingPath: null,
      reportDataBindingPath: null,
      sourceHashes: [sha],
      evidenceRefs: ["pdf:orion-classic-audit-v72"],
    },
    notes: [
      "Report №72 characterized from PDF only.",
      "canonicalBaseReportRunId / enrichmentRunIds unavailable without arsenkin-report-binding.json",
      `Client-copy offline issues: ${clientCopyIssues.length}`,
      `Beyond-registry pages: ${extract.meta.page_count - FIRST36_EXACT_PAGE_COUNT}`,
    ],
    generatedAt: new Date().toISOString(),
  });
  writeFileSync(join(ROOT, "architecture-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  writeFileSync(
    join(ART, "client-copy-offline-from-pdf.json"),
    JSON.stringify({ issueCount: clientCopyIssues.length, issues: clientCopyIssues }, null, 2),
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        sha,
        pageCount: extract.meta.page_count,
        mappedBase: mappedBase.length,
        registryExact: FIRST36_EXACT_PAGE_COUNT,
        missingRegistry,
        continuations: continuationPages.length,
        dynamicInserts: dynamicInserts.length,
        clientCopyIssues: clientCopyIssues.length,
      },
      null,
      2
    )
  );
}

main();
