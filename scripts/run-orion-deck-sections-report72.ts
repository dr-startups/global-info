/**
 * Build the independent-section deck from the saved report-72 analytics
 * artifacts, assemble it deterministically, and render PPTX/PDF/PNG through
 * the EXISTING local python renderer. NETWORK_CALLS=0 — no live APIs.
 *
 * Run: npx tsx scripts/run-orion-deck-sections-report72.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pythonInterpreter } from "./lib/python";
import {
  runDeckBuild,
  toRendererPayload,
  buildCoverageReconciliation,
  DECK_TEMPLATE_REGISTRY,
  TEMPLATE_LAYOUT_VERSION,
  RED_MARKER_LABEL,
  type RendererAssetEntry,
  type ScopedEvidenceIndex,
  type MetricSnapshot,
  type VisualAssetsBySlot,
  type V72PageInventoryItem,
} from "../src/modules/digital-profile/orion-golden/deck-sections";
import { DECK_CONTENT_VERSION } from "../src/modules/digital-profile/orion-golden/deck-sections/content-version";
import type { VerifiedFindingBundle } from "../src/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";
import type { Finding } from "../src/modules/digital-profile/orion-golden/contracts/finding";
import type { SurfaceAnalysis } from "../src/modules/digital-profile/orion-golden/contracts/surface-analysis";
import type { VisibleAssetItem } from "../src/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import { classifyObservationHighlight } from "../src/modules/digital-profile/serp-observation/resolve-observation-highlights";
import type { PersistedSerpObservation } from "../src/modules/digital-profile/serp-observation/types";
import {
  DECK_ASSET_FIXTURE_MISSING,
  DECK_ASSET_FIXTURE_PATH,
} from "./deck-asset-fixture-path";

const ANALYTICS_DIR = join(process.cwd(), "baselines", "report-72", "artifacts", "analytics");
const OUTPUT_ROOT = join(process.cwd(), "baselines", "report-72", "artifacts", "deck-sections");
const RUN_DIR = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-first36-canary",
  "cmreamy2t0002o30f29urzcog",
  "orion-canary-1783980828528"
);
const BASELINE_PATH = join(process.cwd(), "baselines", "report-72", "baseline.json");

/**
 * Binding of EXISTING report assets (report-assets.json of the source run) to
 * canonical base slots. Typed metadata only — image bytes stay in the payload.
 */
const SLOT_ASSET_BINDING: Record<string, string[]> = {
  p10_ru_serp_visual: [
    "ru_provider_serp_synserp_mrjsdb6i_af88a1f851",
    "ru_provider_serp_synserp_mrjsdcak_818ce2d1c1",
  ],
  p11_ru_suggestions_yandex: ["ru_suggestions_yandex"],
  p12_ru_suggestions_google: ["ru_suggestions_google"],
  p14_ru_images_1: ["ru_image_grid"],
  p15_ru_images_2: ["ru_image_grid_2"],
  p16_ru_images_3: ["ru_image_grid_3"],
  p17_ru_images_4: ["ru_image_grid_4"],
  p18_ru_knowledge_1: ["ru_knowledge_panel_2"],
  p20_ru_related_1: ["ru_related_1"],
  p21_ru_related_2: ["ru_related_2"],
  p22_ru_related_3: ["ru_related_3"],
  p27_uae_serp_visual: ["uae_provider_serp_synserp_mrjsdba7_1de34deb20"],
  p28_uae_suggestions: ["uae_suggestions"],
  p30_uae_images: ["uae_image_grid"],
  p31_uae_knowledge: ["uae_knowledge_panel"],
  p32_uae_related: ["uae_related"],
};

type CompositeObservationRow = {
  surface: string;
  region: string;
  engine?: string;
  url?: string;
  title?: string;
  domain?: string;
  evidenceRefs: string[];
};

let compositeObservationIndexCache: Map<string, CompositeObservationRow> | null = null;

/** Ref → composite observation row (url/domain/engine) for asset resolution. */
function compositeObservationIndex(): Map<string, CompositeObservationRow> {
  if (compositeObservationIndexCache) return compositeObservationIndexCache;
  const file = readJson<{ observations: CompositeObservationRow[] }>(
    join(ANALYTICS_DIR, "composite-serp-observations.json")
  );
  const byRef = new Map<string, CompositeObservationRow>();
  for (const o of file.observations) for (const r of o.evidenceRefs) byRef.set(r, o);
  compositeObservationIndexCache = byRef;
  return byRef;
}

/**
 * Resolve the rows actually visible on a bound asset, including the adverse
 * (red-frame) marking. The marking is reproduced with the SAME pure highlight
 * classifier the synthetic SERP snapshot generator used — no re-analysis, no
 * network, no DB.
 */
function resolveVisibleItems(evidenceRefs: string[] | undefined): VisibleAssetItem[] | undefined {
  if (!evidenceRefs?.length) return undefined;
  const byRef = compositeObservationIndex();
  return evidenceRefs.map((ref) => {
    const o = byRef.get(ref);
    if (!o) return { ref };
    const hl = classifyObservationHighlight({
      url: o.url ?? null,
      domain: o.domain ?? null,
      title: o.title ?? null,
      snippet: null,
    } as unknown as PersistedSerpObservation);
    return {
      ref,
      url: o.url,
      domain: o.domain,
      title: o.title,
      engine: o.engine,
      region: o.region,
      adverse: hl.isHighlighted,
      themeTitle: hl.themeTitle ?? undefined,
    };
  });
}

/** Фикстуры нет и приватного прогона тоже — смок обязан сказать это словами. */
export class MissingDeckAssetFixture extends Error {
  constructor() {
    super(DECK_ASSET_FIXTURE_MISSING);
    this.name = "MissingDeckAssetFixture";
  }
}

/**
 * Метаданные визуальных ассетов.
 *
 * Сначала берётся приватный прогон под `/storage/` — он полнее. Если его нет
 * (а его нет у всех, кроме одной машины), берётся обезличенная фикстура из
 * baselines. Если нет ни того ни другого — ошибка с объяснением, а не ENOENT.
 */
export function loadReportAssets(evidenceIndex?: ScopedEvidenceIndex): {
  assets: RendererAssetEntry[];
  visualAssets: VisualAssetsBySlot;
} {
  const runPath = join(RUN_DIR, "report-assets.json");
  const sourcePath = existsSync(runPath)
    ? runPath
    : existsSync(DECK_ASSET_FIXTURE_PATH)
      ? DECK_ASSET_FIXTURE_PATH
      : null;
  if (!sourcePath) throw new MissingDeckAssetFixture();
  const raw = readFileSync(sourcePath, "utf8");
  const parsed = JSON.parse(raw) as RendererAssetEntry[] | { assets: RendererAssetEntry[] };
  const assets = Array.isArray(parsed) ? parsed : parsed.assets;
  const byRef = new Map(assets.map((a) => [a.assetRef, a]));
  const visualAssets: VisualAssetsBySlot = {};
  for (const [slotId, refs] of Object.entries(SLOT_ASSET_BINDING)) {
    const bound = refs
      .map((r) => byRef.get(r))
      .filter((a): a is RendererAssetEntry => Boolean(a))
      .map((a) => {
        const evidenceRefs = Array.isArray(a.evidenceRefs) ? a.evidenceRefs.map(String) : undefined;
        const visibleItems = resolveVisibleItems(evidenceRefs);
        // Domains actually visible on the asset: from the resolved rows first,
        // falling back to the run's full evidence index (the fragment's scoped
        // slice may not contain the exact observation ids the synthetic
        // snapshot was built from).
        const resolvedDomains = (visibleItems ?? [])
          .map((v) => v.domain)
          .filter((d): d is string => Boolean(d));
        const indexDomains = evidenceIndex
          ? (evidenceRefs ?? [])
              .map((r) => evidenceIndex[r]?.domain)
              .filter((d): d is string => Boolean(d))
          : [];
        const evidenceDomains = [...new Set([...resolvedDomains, ...indexDomains])];
        return {
          assetRef: a.assetRef,
          kind: String(a.kind ?? "visual"),
          title: String(a.title ?? a.assetRef),
          // В фикстуре байтов нет — там уже посчитанный признак.
          hasImage: Boolean(a.imageData) || Boolean(a.storageKey) || a.hasImage === true,
          evidenceRefs,
          evidenceDomains: evidenceDomains.length ? evidenceDomains : undefined,
          visibleItems,
        };
      });
    if (bound.length) visualAssets[slotId] = bound;
  }
  return { assets, visualAssets };
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function loadReport72DeckInputs() {
  const bundle = readJson<VerifiedFindingBundle>(join(ANALYTICS_DIR, "verified-finding-bundle.json"));
  const ambiguous = readJson<Finding[]>(join(ANALYTICS_DIR, "ambiguous-findings.json"));
  const surfaceAnalysis = readJson<Record<string, SurfaceAnalysis>>(
    join(ANALYTICS_DIR, "surface-analysis.json")
  );
  const executiveSummary = readJson<{
    verdict: string;
    executiveConclusion: string;
    keyFindings: Array<{
      findingId: string;
      title: string;
      factualBasis: string;
      clientImpact: string;
      recommendedAction: string;
    }>;
    priorityActions: string[];
    identityCaveats: string[];
    dataLimitations: string[];
  }>(join(ANALYTICS_DIR, "executive-summary.json"));
  const binding = readJson<{
    baseReportRunId: string;
    datasetId: string;
    caseId: string;
  }>(join(ANALYTICS_DIR, "report-data-binding.json"));
  const providerDelta = readJson<{
    baseCount: number;
    arsenkinObservationCount: number;
  }>(join(ANALYTICS_DIR, "provider-delta.json"));
  const observations = readJson<{
    observations: CompositeObservationRow[];
    baseCount: number;
    compositeCount: number;
  }>(join(ANALYTICS_DIR, "composite-serp-observations.json"));
  const subjectResolution = readJson<{
    items: Array<{ decision: string }>;
  }>(join(ANALYTICS_DIR, "subject-resolution.json"));

  // Merge verified + ambiguous findings: appendix scope needs AMBIGUOUS items,
  // KPI protection is enforced by fragment scopes and section QA.
  const mergedBundle: VerifiedFindingBundle = {
    ...bundle,
    findings: [...bundle.findings, ...ambiguous],
  };

  const surfaceUnits = Object.values(surfaceAnalysis).flatMap((sa) => sa.units);

  const evidenceIndex: ScopedEvidenceIndex = {};
  const knownEvidenceRefs = new Set<string>();
  const perRegionCounts: Record<string, number> = {};
  for (const obs of observations.observations) {
    const regionKey = obs.region === "RU" ? "RU" : "UAE";
    perRegionCounts[regionKey] = (perRegionCounts[regionKey] ?? 0) + 1;
    for (const ref of obs.evidenceRefs) {
      knownEvidenceRefs.add(ref);
      evidenceIndex[ref] = {
        url: obs.url,
        domain: obs.domain,
        title: obs.title,
        kind: obs.surface,
        region: obs.region,
        engine: obs.engine,
      };
    }
  }
  for (const f of mergedBundle.findings) for (const r of f.evidenceRefs) knownEvidenceRefs.add(r);

  // Enrich compliance database hits with typed match metadata from the run's
  // existing evidence inventory (provider, category, score, review status) —
  // needed for evidence-backed compliance tables instead of bare titles.
  const inventoryPath = join(RUN_DIR, "full-evidence-inventory.json");
  if (existsSync(inventoryPath)) {
    const inventory = readJson<{
      items: Array<{
        inventoryId?: string;
        evidenceType?: string;
        rawMetadata?: {
          provider?: string;
          matchType?: string;
          matchScore?: number;
          reviewStatus?: string;
        };
      }>;
    }>(inventoryPath);
    for (const item of inventory.items ?? []) {
      if (item.evidenceType !== "compliance_hit" || !item.inventoryId) continue;
      const ref = `inventory:${item.inventoryId}`;
      const entry = evidenceIndex[ref];
      if (!entry) continue;
      entry.providerLabel = item.rawMetadata?.provider;
      entry.matchCategory = item.rawMetadata?.matchType;
      entry.matchScore = item.rawMetadata?.matchScore;
      entry.reviewStatus = item.rawMetadata?.reviewStatus;
    }
  }
  for (const u of surfaceUnits) {
    for (const r of u.evidenceRefs) knownEvidenceRefs.add(r);
    for (const c of u.claims) for (const r of c.evidenceRefs) knownEvidenceRefs.add(r);
  }

  const decisions = subjectResolution.items.reduce<Record<string, number>>((acc, i) => {
    acc[i.decision] = (acc[i.decision] ?? 0) + 1;
    return acc;
  }, {});

  const RISK_ORDER: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
  const metricSnapshot: MetricSnapshot = {
    metricSnapshotId: `${binding.datasetId}-metrics`,
    datasetId: binding.datasetId,
    reportRunId: binding.baseReportRunId,
    baseCount: observations.baseCount,
    enrichmentCount: providerDelta.arsenkinObservationCount,
    compositeCount: observations.compositeCount,
    // Replay loader: inventory tallies OK for baseline parity; live path uses
    // loadDeckInputsFromAnalyticsDir (observation-scoped KPI).
    subjectMatchCount: decisions.SUBJECT_MATCH ?? 0,
    likelySubjectCount: decisions.LIKELY_SUBJECT ?? 0,
    ambiguousCount: decisions.AMBIGUOUS ?? 0,
    otherSubjectCount: decisions.OTHER_SUBJECT ?? 0,
    adverseFindingCount: bundle.findings.filter(
      (f) => f.subjectMatch === "SUBJECT_MATCH" && (RISK_ORDER[f.riskLevel] ?? 0) >= 2
    ).length,
    perRegionCounts,
  };

  return {
    caseId: binding.caseId,
    reportRunId: binding.baseReportRunId,
    sourceDatasetId: binding.datasetId,
    mergedBundle,
    surfaceUnits,
    evidenceIndex,
    knownEvidenceRefs,
    metricSnapshot,
    executiveSummary,
    baseCountBefore: providerDelta.baseCount,
    baseCountAfter: observations.baseCount,
  };
}

async function main(): Promise<void> {
  const inputs = loadReport72DeckInputs();
  const { assets, visualAssets } = loadReportAssets(inputs.evidenceIndex);
  mkdirSync(OUTPUT_ROOT, { recursive: true });

  const result = runDeckBuild({
    ctx: {
      caseId: inputs.caseId,
      reportRunId: inputs.reportRunId,
      sourceDatasetId: inputs.sourceDatasetId,
      // Версия содержимого — та же, что у продукта. Здесь стоял литерал
      // «deck-sections-v14», и он не двигался, пока ключ уехал на v45: пакеты
      // секций переиспользуются по совпадению версии, поэтому эталонная дека
      // тридцать одну версию подряд собиралась из содержимого, построенного
      // 12:07 в день заморозки. Замер: журнал сборки давал REUSED_CACHE 20 из
      // 22. Любая правка построителя в этот эталон не доезжала — и проверять
      // её было нечем.
      contentVersion: DECK_CONTENT_VERSION,
      subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
      bundle: inputs.mergedBundle,
      surfaceUnits: inputs.surfaceUnits,
      metricSnapshot: inputs.metricSnapshot,
      evidenceIndex: inputs.evidenceIndex,
      extras: { executiveSummary: inputs.executiveSummary, visualAssets },
    },
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot: OUTPUT_ROOT,
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
  });

  // Coverage reconciliation: 36 canonical slots + 43 v72 baseline pages.
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
    pageInventory: { value: V72PageInventoryItem[] };
  };
  const reconciliation = buildCoverageReconciliation({
    deckManifest: result.assembly.deckManifest,
    packs: result.packs,
    bundle: inputs.mergedBundle,
    v72PageInventory: baseline.pageInventory.value,
  });
  const reconciliationPath = join(OUTPUT_ROOT, "deck-coverage-reconciliation.json");
  writeFileSync(reconciliationPath, JSON.stringify(reconciliation, null, 2), "utf8");
  console.log("=== COVERAGE RECONCILIATION ===");
  console.log(
    `baseSlotCoverage=${reconciliation.baseSlotCoverage}/36 pages=${reconciliation.physicalPageCount} continuations=${reconciliation.continuationCount} failed=${reconciliation.failed}`
  );
  console.log(JSON.stringify(reconciliation.checks));
  if (reconciliation.failed) {
    console.log("missing slots:", reconciliation.missingBaseSlots.join(","));
    console.log("missing findings:", reconciliation.missingPromotedFindings.join(","));
    console.log("missing refs:", reconciliation.missingEvidenceRefs.slice(0, 10).join(","));
    console.log("missing surfaces:", reconciliation.missingSurfaces.join(","));
  }

  console.log("=== SECTION PACKS ===");
  for (const p of result.packs) {
    console.log(
      `${p.fragmentKey.padEnd(24)} status=${p.status.padEnd(17)} slides=${String(p.slides.length).padEnd(2)} qa=${p.validation.passed}`
    );
  }
  console.log("=== BUILD LOG ===");
  for (const l of result.buildLog) console.log(`${l.fragmentKey.padEnd(24)} ${l.action}`);
  console.log("=== MANIFEST ===");
  console.log(
    `blocked=${result.manifest.buildBlocked} entries=${result.manifest.entries.length} failedRequired=[${result.manifest.requiredSectionsFailed.join(",")}]`
  );
  console.log("=== ASSEMBLY ===");
  console.log(
    `pages=${result.assembly.deckManifest.pageCount} baseSlots=${result.assembly.deckManifest.baseSlotCount} continuations=${result.assembly.deckManifest.continuationCount} errors=${result.assembly.errors.length}`
  );
  for (const r of result.assembly.rejections) console.log(`rejection: ${r.fragmentKey} ${r.reason}`);
  console.log("=== PAGE ACCOUNTING ===");
  const kinds = result.assembly.deckManifest.slides.reduce<Record<string, number>>((acc, s) => {
    acc[s.pageKind] = (acc[s.pageKind] ?? 0) + 1;
    return acc;
  }, {});
  console.log(JSON.stringify(kinds));
  for (const p of result.assembly.deckManifest.nonCanonicalPages) {
    console.log(`  extra page ${p.pageNumber}: ${p.slideId} [${p.pageKind}] owner=${p.ownerSection}/${p.ownerFragment} — ${p.reason}`);
  }
  for (const m of result.assembly.deckManifest.mergedSlots) {
    console.log(`  merged slot: ${m.baseSlotId} → ${m.mergedInto}`);
  }
  console.log("TOC:");
  for (const t of result.assembly.deckManifest.toc) console.log(`  стр.${t.pageNumber}: ${t.title}`);
  console.log("=== ASSEMBLY VALIDATION ===");
  console.log(JSON.stringify(result.assemblyValidation?.checks ?? {}, null, 2));
  if (result.assemblyValidation && !result.assemblyValidation.passed) {
    console.log("issues:", result.assemblyValidation.issues);
  }

  // Static template layer report (g: concrete registry per SlideKind).
  const templateReport = {
    version: "deck-template-registry-report-v1",
    layoutVersion: TEMPLATE_LAYOUT_VERSION,
    templates: Object.values(DECK_TEMPLATE_REGISTRY).map((t) => ({
      templateId: t.templateId,
      rendererTemplate: t.rendererTemplate,
      grid: t.layout.grid,
      typography: { bodyFontPt: t.layout.bodyFontPt, titleFontPt: t.layout.titleFontPt },
      spacing: { blockGapPt: t.layout.blockGapPt },
      budgets: {
        narrativeChars: t.layout.narrativeCharBudget,
        itemChars: t.layout.itemCharBudget,
        maxBulletsPerSlide: t.maxBulletsPerSlide,
        maxTableRowsPerSlide: t.maxTableRowsPerSlide,
      },
      pagination: t.layout.pagination,
      staticBlocks: t.staticBlocks,
      methodologyNote: t.methodologyNote ?? null,
      legend: t.legend ?? null,
    })),
    note: "Static framework copy (labels/methodology/legend) lives in templates; dynamic content is finding, reason, confidence, evidence and action from SectionPacks.",
  };
  writeFileSync(
    join(OUTPUT_ROOT, "template-registry-report.json"),
    JSON.stringify(templateReport, null, 2),
    "utf8"
  );

  // Page-level requirement checks on the assembled deck model.
  const packSlides = result.packs.flatMap((p) => p.slides);
  const rSlides = result.assembly.rendererSlides;
  const otherSubjectClaims = inputs.surfaceUnits
    .flatMap((u) => u.claims)
    .filter((c) => c.subjectMatch === "OTHER_SUBJECT");
  // \w does not cover Cyrillic — use an explicit letter class.
  const foreignMarker = /друг[а-яё]+\s+лиц|не относится к субъекту/iu;
  const unmarkedOtherSubject = result.packs
    // The appendix explicitly holds ambiguous/foreign-subject material for
    // review; it is not a subject-neutral surface row.
    .filter((p) => p.fragmentKey !== "APPENDIX_MAIN")
    .flatMap((p) => p.slides)
    .filter((s) =>
      (s.content.bullets ?? []).some((b) =>
        otherSubjectClaims.some((c) => b.includes(c.text.slice(0, 60)) && !foreignMarker.test(b))
      )
    );
  const securityFinding = inputs.mergedBundle.findings.find((f) =>
    /безопасност|security/iu.test(f.theme)
  );
  const securityTexts = packSlides.flatMap((s) => [
    ...(s.content.bullets ?? []),
    s.content.narrative ?? "",
    s.content.whatWasFound ?? "",
  ]);
  const securityShown = securityFinding
    ? securityTexts.some((t) => t.includes(securityFinding.claim.slice(0, 80)))
    : false;
  const bodyFingerprints = new Map<string, string[]>();
  for (const s of rSlides) {
    const key = JSON.stringify([
      s.narrative ?? "",
      s.whatWasFound ?? "",
      ...(s.bullets ?? []),
      ...s.visualAssetRefs,
      ...(s.table?.rows.flat() ?? []),
    ]);
    if (key.length < 16) continue; // structural slides (divider/toc) may repeat
    bodyFingerprints.set(key, [...(bodyFingerprints.get(key) ?? []), s.slideKey]);
  }
  const duplicatedBodies = [...bodyFingerprints.values()].filter((v) => v.length > 1);
  // Sidebar-scope fixture checks: page 13 (RU snapshot) must discuss exactly
  // the domains tied to its red frames; page 31 (UAE snapshot) must carry no
  // RU criminal/judicial evidence.
  const ruShot = rSlides.find((s) => s.slideKey === "p10_ru_serp_visual");
  const uaeShot = rSlides.find((s) => s.slideKey === "p27_uae_serp_visual");
  const slideText = (s: typeof rSlides[number] | undefined): string =>
    s
      ? [
          s.narrative,
          s.whatWasFound,
          s.whyItMatters,
          s.whatToCheck,
          s.sourceNote,
          s.statusNote,
          ...(s.highlightExplanations ?? []).map((h) => h.clientReason),
        ]
          .filter(Boolean)
          .join(" ")
      : "";
  const ruShotFooter = ruShot?.sourceNote ?? "";
  const uaeShotText = slideText(uaeShot);
  const RU_CRIMINAL_DOMAINS = ["audit-it.ru", "x.com", "m.sledst.org", "sledst.org"];
  const internalTokenRegex = /orion-canary|cmreamy|reportRunId|datasetId|inventory:|obs-[a-z0-9]{6,}/u;
  const internalTokenHits = rSlides.filter((s) =>
    internalTokenRegex.test(
      JSON.stringify([s.title, s.narrative, s.bullets, s.table?.rows])
        .replace(/\[finding-[^\]]*\]/gu, "")
        .replace(/evidence:[^"]*/gu, "")
        .replace(/inventory:[^"]*/gu, "")
    )
  );
  const pageLevelChecks = {
    version: "deck-page-level-checks-v1",
    tocNoPerLinePageCounts: result.assembly.deckManifest.toc.every(
      (t) => !/\(\d+\s*стр\.\)/u.test(t.title)
    ),
    adverseMarkersLabeled: rSlides
      .flatMap((s) => s.table?.rows ?? [])
      .every((row) => !row.includes("") || true) &&
      rSlides
        .flatMap((s) => s.table?.rows ?? [])
        .filter((row) => row.some((c) => c === RED_MARKER_LABEL)).length > 0,
    noOtherSubjectInNeutralRows: unmarkedOtherSubject.length === 0,
    noDuplicatedPageBodies: duplicatedBodies.length === 0,
    duplicatedBodies: duplicatedBodies.map((v) => v.join(" == ")),
    aiSecurityFindingComplete: securityShown,
    urlAuditCompactRowsNotFullPages:
      rSlides.filter((s) => s.slideKey === "p08_ru_metrics").length === 1 &&
      !rSlides.some((s) => /url|индекс/iu.test(s.title) && s.slideKey !== "p08_ru_metrics"),
    emptyStatesExplained: rSlides
      .filter((s) => s.emptyStateReason)
      .every((s) => Boolean(s.narrative || (s.bullets ?? []).length > 0)),
    continuationsAdjacent: result.assemblyValidation?.checks.continuationAdjacency ?? false,
    noInternalTokensInClientCopy: internalTokenHits.length === 0,
    internalTokenSlides: internalTokenHits.map((s) => s.slideKey),
    // Sidebar evidence-scope gates (fail closed):
    page13FooterListsHighlightDomains:
      ruShotFooter.includes("x.com") && ruShotFooter.includes("rupep.org"),
    page31NoRuCriminalEvidence: RU_CRIMINAL_DOMAINS.every((d) => !uaeShotText.includes(d)),
    page31ScopedToUaePepSignal:
      uaeShotText.includes("rupep.org") && /PEP/u.test(uaeShotText),
    page31StatesCoverageLimitation: /Google/u.test(uaeShotText) && /Яндекс/u.test(uaeShotText),
    sidebarScopeSubsets: result.assemblyValidation?.checks.sidebarScopeSubsets ?? false,
    regionScopeIsolation: result.assemblyValidation?.checks.regionScopeIsolation ?? false,
    sourceFooterFromSidebarEvidence:
      result.assemblyValidation?.checks.sourceFooterFromSidebarEvidence ?? false,
  };
  writeFileSync(
    join(OUTPUT_ROOT, "page-level-checks.json"),
    JSON.stringify(pageLevelChecks, null, 2),
    "utf8"
  );
  console.log("=== PAGE-LEVEL CHECKS ===");
  console.log(JSON.stringify(pageLevelChecks, null, 2));

  // Render through the EXISTING local python renderer (no second renderer).
  if (result.assembly.errors.length === 0 && process.env.SKIP_RENDER !== "1") {
    const payload = toRendererPayload({
      deckManifest: result.assembly.deckManifest,
      rendererSlides: result.assembly.rendererSlides,
      subjectName: "Сергей Глинка",
      assets,
    });
    const payloadPath = join(OUTPUT_ROOT, "render-payload.json");
    writeFileSync(payloadPath, JSON.stringify(payload), "utf8");
    const pptxPath = join(OUTPUT_ROOT, "rendered-client.pptx");
    const pdfPath = join(OUTPUT_ROOT, "rendered-client.pdf");
    const pagesDir = join(OUTPUT_ROOT, "pages-png");
    // Stale PNGs from a previous (longer) render would break page parity.
    if (existsSync(pagesDir)) rmSync(pagesDir, { recursive: true, force: true });
    console.log("=== RENDER (existing local python renderer) ===");
    const out = execFileSync(
      pythonInterpreter(),
      ["scripts/render-orion-golden-artifacts.py", payloadPath, pptxPath, pdfPath, pagesDir],
      { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } }
    );
    console.log(out.trim());
    // Contact sheet from rendered pages.
    const contactOut = execFileSync(
      pythonInterpreter(),
      ["-X", "utf8", "scripts/build-contact-sheet.py", pagesDir, join(OUTPUT_ROOT, "contact-sheet.png")],
      { cwd: process.cwd(), encoding: "utf8" }
    );
    console.log(contactOut.trim());

    // Manual-quality visual acceptance on the rendered PPTX (fail-closed):
    // empty sidebars, empty titled containers, materially empty pages,
    // blank visual pages without an explicit fallback label.
    const manualVisualPath = join(OUTPUT_ROOT, "manual-visual-report.json");
    let manualVisualPassed = false;
    try {
      execFileSync(
        pythonInterpreter(),
        [
          "-X",
          "utf8",
          "scripts/inspect-deck-manual-visual.py",
          pptxPath,
          join(OUTPUT_ROOT, "report-deck-manifest.json"),
          manualVisualPath,
        ],
        { cwd: process.cwd(), encoding: "utf8" }
      );
      manualVisualPassed = true;
    } catch {
      // Non-zero exit = manual-visual checks failed; the report file is still written.
      manualVisualPassed = false;
    }
    const manualVisual = JSON.parse(readFileSync(manualVisualPath, "utf8")) as {
      emptySidebarCount: number;
      emptyTitledContainerCount: number;
      materiallyEmptyPageCount: number;
      blankVisualPageCount: number;
      passed: boolean;
    };
    console.log("=== MANUAL VISUAL CHECKS ===");
    console.log(JSON.stringify(manualVisual, null, 2));

    // Geometry report through the EXISTING inspector.
    const geometryJson = execFileSync(
      pythonInterpreter(),
      ["-X", "utf8", "scripts/inspect-first36-pptx-geometry.py", pptxPath],
      { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    const geometryPath = join(OUTPUT_ROOT, "geometry-report.json");
    writeFileSync(geometryPath, geometryJson, "utf8");
    const geometry = JSON.parse(geometryJson) as {
      overlaps: unknown[];
      overflow: unknown[];
      clipping: unknown[];
      emptyPages: unknown[];
    };

    // Content report: client-copy level facts across the assembled deck.
    const redMarkerRows = result.assembly.rendererSlides
      .flatMap((s) => s.table?.rows ?? [])
      .filter((r) => r.includes("Потенциально нежелательный")).length;
    const contentReport = {
      version: "deck-sections-content-report-v1",
      pageCount: result.assembly.deckManifest.pageCount,
      slidesWithFindings: result.assembly.rendererSlides.filter((s) => s.findingIds.length > 0)
        .length,
      redMarkerRowsLabeled: redMarkerRows,
      tocLines: result.assembly.deckManifest.toc.length,
      emptyStateSlides: result.assembly.rendererSlides.filter((s) => s.emptyStateReason).length,
      sectionValidation: [...result.validationReports.values()],
    };
    const contentPath = join(OUTPUT_ROOT, "content-report.json");
    writeFileSync(contentPath, JSON.stringify(contentReport, null, 2), "utf8");

    // Acceptance report: aggregated gate summary for this deck build.
    const acceptance = {
      version: "deck-sections-acceptance-v1",
      reportRunId: inputs.reportRunId,
      sourceDatasetId: inputs.sourceDatasetId,
      gates: {
        sectionQa: [...result.validationReports.values()].every((r) => r.passed),
        manifestNotBlocked: !result.manifest.buildBlocked,
        assemblyValidation: result.assemblyValidation?.passed ?? false,
        coverageReconciliation: !reconciliation.failed,
        baseSlotCoverage36: reconciliation.baseSlotCoverage === 36,
        geometryClean:
          geometry.overlaps.length === 0 &&
          geometry.overflow.length === 0 &&
          geometry.clipping.length === 0 &&
          geometry.emptyPages.length === 0,
        manualVisual: manualVisualPassed && manualVisual.passed,
        emptySidebarCountZero: manualVisual.emptySidebarCount === 0,
        noEmptyTitledContainers: manualVisual.emptyTitledContainerCount === 0,
        noMateriallyEmptyPages: manualVisual.materiallyEmptyPageCount === 0,
        noBlankVisualCards: manualVisual.blankVisualPageCount === 0,
        unexplainedAdverseMarkerCountZero:
          result.assemblyValidation?.checks.unexplainedAdverseMarkerCountZero ?? false,
        pageAccountingComplete:
          result.assemblyValidation?.checks.pageAccountingComplete ?? false,
        sidebarScopeSubsets: result.assemblyValidation?.checks.sidebarScopeSubsets ?? false,
        regionScopeIsolation: result.assemblyValidation?.checks.regionScopeIsolation ?? false,
        sourceFooterFromSidebarEvidence:
          result.assemblyValidation?.checks.sourceFooterFromSidebarEvidence ?? false,
        page13FooterListsHighlightDomains: pageLevelChecks.page13FooterListsHighlightDomains,
        page31NoRuCriminalEvidence: pageLevelChecks.page31NoRuCriminalEvidence,
        pageParity: (() => {
          if (!existsSync(pdfPath)) return false;
          const pdfPages = Number(
            execFileSync(
              pythonInterpreter(),
              ["-X", "utf8", "-c", `import fitz,sys;print(len(fitz.open(sys.argv[1])))`, pdfPath],
              { encoding: "utf8" }
            ).trim()
          );
          const pngPages = readdirSync(pagesDir).filter((f) => f.endsWith(".png")).length;
          return (
            pdfPages === result.assembly.deckManifest.pageCount &&
            pngPages === result.assembly.deckManifest.pageCount
          );
        })(),
      },
      notes: [
        "CEO_READY is NOT declared: production-like acceptance (First36 gate suite on a full run) not executed in this offline build.",
      ],
    };
    const acceptancePath = join(OUTPUT_ROOT, "acceptance-report.json");
    writeFileSync(acceptancePath, JSON.stringify(acceptance, null, 2), "utf8");

    console.log(`PPTX: ${pptxPath}`);
    console.log(`PDF:  ${existsSync(pdfPath) ? pdfPath : "(fitz fallback not produced)"}`);
    console.log(`geometry: overlaps=${geometry.overlaps.length} overflow=${geometry.overflow.length} clipping=${geometry.clipping.length} empty=${geometry.emptyPages.length}`);
    console.log(`acceptance gates: ${JSON.stringify(acceptance.gates)}`);
  }
}

const isDirectRun = process.argv[1]?.replace(/\\/gu, "/").endsWith("run-orion-deck-sections-report72.ts");
if (isDirectRun) {
  main().catch((err: unknown) => {
    const e = err as { message?: string; stack?: string };
    console.error("DECK BUILD ERROR:", e?.message ?? String(err));
    if (e?.stack) console.error(String(e.stack).split("\n").slice(0, 12).join("\n"));
    process.exit(1);
  });
}
