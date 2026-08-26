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
  loadDeckInputsFromAnalyticsDir,
  runDeckBuildMeasured,
  toRendererPayload,
  buildCoverageReconciliation,
  DECK_TEMPLATE_REGISTRY,
  TEMPLATE_LAYOUT_VERSION,
  RED_MARKER_LABEL,
  type CanonicalDeckInputs,
  type RendererAssetEntry,
  type ScopedEvidenceIndex,
  type VisualAssetsBySlot,
  type V72PageInventoryItem,
  type BulletMeasureAdapter,
} from "../src/modules/digital-profile/orion-golden/deck-sections";
import { createLocalPythonMeasureAdapter } from "../src/modules/digital-profile/services/render-deck-artifacts";
import { DECK_CONTENT_VERSION } from "../src/modules/digital-profile/orion-golden/deck-sections/content-version";
import { normalizeForCompare } from "../src/modules/digital-profile/orion-golden/deck-sections/text-compare";
import { scanDeckForLeakedIdentifiers } from "../src/modules/digital-profile/orion-golden/deck-sections/internal-code-scan";
import type { VisibleAssetItem } from "../src/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import type {
  ExecutiveSummaryExtras,
  UncategorizedMaterialsExtras,
} from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ComposedClientSummary } from "../src/modules/digital-profile/orion-golden/contracts/composed-client-summary";
import { classifyObservationHighlight } from "../src/modules/digital-profile/serp-observation/resolve-observation-highlights";
import { evidenceRowVerdict } from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { panelRowWithOwnership } from "../src/modules/digital-profile/services/canonical-visual-assets";
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

/** Субъект эталонного прогона — один ответ на сборку и на пейлоад рендера. */
const SUBJECT_NAME = "Сергей Глинка";

/**
 * Мерный прогон локальным python — та же реализация, что у продукта.
 *
 * Приёмка обязана собирать деку тем же циклом: иначе она мерит раскладку,
 * которой живой путь никогда не выпустит.
 *
 * Интерпретатор ищется в момент вызова, а не при импорте: этот модуль
 * импортируют офлайн-юниты ради загрузчика входов и разбора ворот, а
 * `npm run ci` обязан проходить без рендерера — и без Python.
 */
const measureWithLocalPython: BulletMeasureAdapter = (payload) =>
  createLocalPythonMeasureAdapter(pythonInterpreter())(payload);

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

/**
 * Строки, видимые на привязанном ассете, вместе с красной рамкой.
 *
 * Индекс здесь тот же, которым построители печатают страницу: собственный
 * индекс скрипта не разрешал `inventory:`-ссылки, и панель с четырьмя
 * запросами отдавала ноль строк с текстом — а страница рядом печатала
 * «0 связанных запросов». Рамка воспроизводится тем же чистым классификатором,
 * которым её ставил генератор снимка, — без пересчёта, без сети и без базы.
 *
 * Принадлежность применяется той же функцией, что и у продукта, и только к
 * панелям-спискам: снимки выдачи и сетки картинок остаются ownership-blind,
 * как их рисует `buildCanonicalVisualAssets`.
 */
function resolveVisibleItems(
  evidenceRefs: string[] | undefined,
  evidenceIndex: ScopedEvidenceIndex,
  kind: string
): VisibleAssetItem[] | undefined {
  if (!evidenceRefs?.length) return undefined;
  return evidenceRefs.map((ref) => {
    const e = evidenceIndex[ref];
    if (!e) return { ref };
    // Реконструкция обязана быть не слабее продукта: словарь читает сниппет, а
    // решение по прочитанной странице сильнее словаря. Пока сюда ехали
    // `snippet: null` и ни одного вердикта, ворота были слепы к целому классу
    // срабатываний — и зелены на данных, где продукт повёл бы себя иначе.
    const hl = classifyObservationHighlight(
      {
        url: e.url ?? null,
        domain: e.domain ?? null,
        title: e.title ?? null,
        snippet: e.snippet ?? null,
      } as unknown as PersistedSerpObservation,
      evidenceRowVerdict(e)
    );
    const item: VisibleAssetItem = {
      ref,
      url: e.url,
      domain: e.domain,
      title: e.title,
      engine: e.engine,
      region: e.region,
      adverse: hl.isHighlighted,
      themeTitle: hl.themeTitle ?? undefined,
    };
    if (kind !== "surface_panel") return item;
    return panelRowWithOwnership({ item, decision: e.subjectDecision }).visible;
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
export function loadReportAssets(evidenceIndex: ScopedEvidenceIndex): {
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
        const kind = String(a.kind ?? "visual");
        const visibleItems = resolveVisibleItems(evidenceRefs, evidenceIndex, kind);
        // Домены, видимые на ассете: из разрешённых строк. Второй перебор по
        // индексу здесь стоял, пока индексов было два, и добавить он уже ничего
        // не может — строки разрешаются тем же индексом.
        const evidenceDomains = [
          ...new Set(
            (visibleItems ?? []).map((v) => v.domain).filter((d): d is string => Boolean(d))
          ),
        ];
        return {
          assetRef: a.assetRef,
          kind,
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

/**
 * Вход деки — тем же загрузчиком, что и у продукта.
 *
 * Здесь стоял второй загрузчик: индекс он строил из сырых `obs.evidenceRefs`,
 * KPI считал по решениям инвентаря и `composite-serp-provenance.json` не читал
 * вовсе. Приёмка мерила деку тем, чего продукт никогда не собирает, — и
 * приняла страницу, где под снимком панели с четырьмя запросами стояло
 * «0 связанных запросов». В скрипте остаётся только фикстура самого прогона:
 * субъект, привязка ассетов, рендер и ворота.
 */
export function loadReport72DeckInputs(): CanonicalDeckInputs {
  return loadDeckInputsFromAnalyticsDir(ANALYTICS_DIR);
}

async function main(): Promise<void> {
  const inputs = loadReport72DeckInputs();
  const { assets, visualAssets } = loadReportAssets(inputs.evidenceIndex);
  mkdirSync(OUTPUT_ROOT, { recursive: true });

  const result = await runDeckBuildMeasured({
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
      subject: { displayName: SUBJECT_NAME, aliases: ["Sergey Glinka"] },
      bundle: inputs.mergedBundle,
      surfaceUnits: inputs.surfaceUnits,
      metricSnapshot: inputs.metricSnapshot,
      evidenceIndex: inputs.evidenceIndex,
      // Состав extras — тот же, что у живого пути: приёмка обязана мерить то,
      // что печатает продукт, а не собственный набор входов.
      extras: {
        executiveSummary: inputs.executiveSummary as unknown as ExecutiveSummaryExtras,
        composedClientSummary:
          (inputs.composedClientSummary as unknown as ComposedClientSummary) ?? undefined,
        surfaceCollectionHints: inputs.surfaceCollectionHints,
        complianceScreenings: inputs.complianceScreenings,
        uncategorizedMaterials:
          (inputs.uncategorizedMaterials as UncategorizedMaterialsExtras | null) ?? undefined,
        visualAssets,
      },
    },
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot: OUTPUT_ROOT,
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
    // Наблюдения для сверки печатной таблицы выдачи — вход тех же ворот, что
    // работают на живом пути.
    serpObservations: inputs.serpObservations,
    subjectName: SUBJECT_NAME,
    assets,
    // Реплей собирает деку тем же циклом, что и продукт: мера идёт локальным
    // транспортом. Отсутствие меры в приёмочном прогоне — отказ, а не пропуск:
    // иначе приёмка мерила бы деку, которую живой путь никогда не соберёт.
    measure: measureWithLocalPython,
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
  // Объявленный пропуск обязан быть видимым: тихо пропущенная проверка
  // выглядит ровно так же, как пройденная.
  for (const skip of result.assemblyValidation?.skipped ?? []) console.log(`skip: ${skip}`);

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
  /*
   * «Что видит клиент» — один ответ на весь проект (`clientVisibleStrings`), и
   * шаблон утёкших идентификаторов живёт рядом с остальными правилами о
   * клиентском тексте. Пока скрипт держал свой список полей, он смотрел четыре
   * поля слайда из шестнадцати и не видел ни панелей, ни плиток, ни полосы
   * адреса — то есть ворота были зелёными по построению на всём, что мимо
   * заголовка, нарратива, буллетов и ячеек таблицы.
   */
  const internalTokenSlideKeys = [
    ...new Set(scanDeckForLeakedIdentifiers(rSlides).map((f) => f.slide)),
  ];
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
    noInternalTokensInClientCopy: internalTokenSlideKeys.length === 0,
    internalTokenSlides: internalTokenSlideKeys,
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

  /*
   * Дека не собралась — это провал приёмки, а не повод её пропустить.
   *
   * Весь блок ворот стоит под условием «ошибок сборки нет», поэтому худший из
   * исходов — отказ обязательной секции и `pageCount: 0` — уходил из прогона
   * нулевым кодом возврата и без единой напечатанной проверки. Ровно тот
   * случай, ради которого раннер смоков считает провалом прогон без единой
   * выполненной проверки.
   */
  if (result.assembly.errors.length > 0) {
    console.error(
      `\nПРИЁМКА НЕ ПРОЙДЕНА: дека не собралась, ошибок сборки — ${result.assembly.errors.length}`
    );
    for (const err of result.assembly.errors.slice(0, 10)) console.error(`  ${err}`);
    process.exitCode = 1;
    return;
  }

  /*
   * Прогон без единой выполненной проверки — провал, а не успех.
   *
   * `SKIP_RENDER=1` выключает рендер, а вместе с ним и весь блок из 26 ворот:
   * скрипт молча заканчивался нулём, ничего не проверив. Это та же форма, что
   * этажом выше у несобранной деки, и то же правило, по которому раннер смоков
   * считает провалом прогон без проверок. Пропуск объявляется словами и красит
   * прогон — иначе его не отличить от пройденного.
   */
  if (process.env.SKIP_RENDER === "1") {
    console.error("# SKIP приёмочные ворота — рендер выключен (SKIP_RENDER=1)");
    console.error("ПРИЁМКА НЕ ВЫПОЛНЕНА: ни одно из ворот не проверялось");
    process.exitCode = 1;
    return;
  }

  // Render through the EXISTING local python renderer (no second renderer).
  {
    const payload = toRendererPayload({
      deckManifest: result.assembly.deckManifest,
      rendererSlides: result.assembly.rendererSlides,
      subjectName: SUBJECT_NAME,
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
    // Телеметрию пишет сам рендер (рядом с PNG); её же читает инспектор выше.
    const layoutTelemetryPath = join(OUTPUT_ROOT, "layout-telemetry.json");
    const layoutTelemetry = existsSync(layoutTelemetryPath)
      ? (JSON.parse(readFileSync(layoutTelemetryPath, "utf8")) as {
          entries?: Array<Record<string, unknown>>;
        })
      : null;
    const geometryPath = join(OUTPUT_ROOT, "geometry-report.json");
    writeFileSync(geometryPath, geometryJson, "utf8");
    const geometry = JSON.parse(geometryJson) as {
      overlaps: unknown[];
      overflow: unknown[];
      clipping: unknown[];
      emptyPages: unknown[];
    };

    // Текст страниц PDF — тем же fitz, что и подсчёт страниц. Читается один
    // раз: ворота сверяют по нему то, что действительно напечатано.
    const pdfPageTexts: string[] = existsSync(pdfPath)
      ? (JSON.parse(
          execFileSync(
            pythonInterpreter(),
            [
              "-X",
              "utf8",
              "-c",
              "import fitz,sys,json;print(json.dumps([p.get_text() for p in fitz.open(sys.argv[1])]))",
              pdfPath,
            ],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
          )
        ) as string[])
      : [];

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
        // Страница не спорит со своей панелью. Отсутствие ключа — отказ, а не
        // пропуск: проверка без входа выглядит точно так же, как пройденная.
        panelPagesMatchDrawnRows:
          result.assemblyValidation?.checks.panelPagesMatchDrawnRows ?? false,
        // Печатная таблица выдачи сходится с наблюдениями. На эталоне 72
        // признака `rankSource` в артефактах нет — проверка объявляет пропуск
        // строкой отчёта, а не молчит.
        serpTableRanksFromOwnEngine:
          result.assemblyValidation?.checks.serpTableRanksFromOwnEngine ?? false,
        // Карточные страницы матрицы обязаны отчитаться о нарисованном:
        // без их телеметрии CONTENT_DROPPED_BY_RENDERER судить нечего.
        riskMatrixTelemetryPresent: riskMatrixTelemetryPresent(
          result.assembly.rendererSlides,
          layoutTelemetry
        ),
        // Сводная комплаенс-таблица называет базы. Ожидаемое число строк
        // считается по наблюдениям артефактов, а не по выходу построителя:
        // ворота, меряющие тем же индексом, зелены вакуумно.
        complianceRowsNameTheirBases: complianceRowsNameTheirBases(
          result.assembly.rendererSlides,
          ANALYTICS_DIR
        ),
        // Строка о другом лице печатается с пометкой на всех поверхностях,
        // кроме приложения: без неё запрос про композитора-однофамильца
        // читается как запрос о субъекте.
        noOtherSubjectInNeutralRows: pageLevelChecks.noOtherSubjectInNeutralRows,
        page13FooterListsHighlightDomains: pageLevelChecks.page13FooterListsHighlightDomains,
        page31NoRuCriminalEvidence: pageLevelChecks.page31NoRuCriminalEvidence,
        // Страницы регионов говорят о чтении. На эталоне это честная ветка
        // «не читались» — ворота не вакуумны, а числовую ветку закрепляют
        // юниты и смок: артефактов чтения у report-72 нет.
        regionalPagesCarryReadingStatus: regionalPagesCarryReadingStatus(
          (payload.deckManifest as { finalSlides: Array<Record<string, unknown>> }).finalSlides
        ),
        // Методология страницы проверки доехала до листа, а не только до
        // полезной нагрузки: этот зазор и пропустил регресс.
        wikipediaCheckTextInPdf: wikipediaCheckTextInPdf(
          result.assembly.rendererSlides,
          (page) => pdfPageTexts[page - 1] ?? ""
        ),
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

    // Переполнение и потеря содержимого — отказ сборки, а не примечание.
    // Ворота считались, писались в файл и печатались, но прогон завершался
    // нулём при любом их значении: `geometryClean: false` держался так с
    // начала переработки и никого не останавливал. Зелёный код возврата при
    // красных воротах — это приёмка, которая ничего не принимает.
    const failed = failedAcceptanceGates(acceptance.gates);
    const total = Object.keys(acceptance.gates).length;
    if (failed.length > 0) {
      console.error(
        `\nПРИЁМКА НЕ ПРОЙДЕНА: ${failed.length} из ${total} ворот — ${failed.join(", ")}`
      );
      console.error(`Подробности: ${acceptancePath}`);
      process.exitCode = 1;
      return;
    }
    console.log(`приёмка: пройдено ${total} из ${total} ворот`);
  }
}

/**
 * В сводной комплаенс-таблице каждая строка называет свою базу.
 *
 * На прогоне 72 три записи (Dow Jones, LexisNexis, World-Check) схлопывались
 * дедупом в одну строку «База данных | — | — | —»: провайдер приходит в
 * наблюдении полем `engine`, а построитель читал только обогащение, которого в
 * замороженных артефактах нет. Ожидаемое число строк берётся из самих
 * наблюдений — если считать его по выходу построителя, ворота подтвердят любую
 * поломку сами себе. Отсутствие входа — отказ, а не пропуск.
 */
export function complianceRowsNameTheirBases(
  rendererSlides: ReadonlyArray<{
    baseSlotId?: string;
    isContinuation?: boolean;
    table?: { rows: string[][] };
  }>,
  analyticsDir: string
): boolean {
  const observationsPath = join(analyticsDir, "composite-serp-observations.json");
  if (!existsSync(observationsPath)) return false;
  const observations = (
    JSON.parse(readFileSync(observationsPath, "utf8")) as {
      observations?: Array<{ surface?: string; engine?: string; title?: string }>;
    }
  ).observations ?? [];
  const expected = new Set(
    observations
      .filter((o) => o.surface === "compliance_hit")
      .map((o) => `${String(o.engine ?? "").toUpperCase()}|${String(o.title ?? "").toLowerCase()}`)
  );
  const summary = rendererSlides.find(
    (s) => s.baseSlotId === "p33_compliance_toc" && !s.isContinuation
  );
  const rows = summary?.table?.rows ?? [];
  if (expected.size === 0) return false;
  if (rows.length !== expected.size) return false;
  // «База данных» — подпись колонки; в ячейке она означает, что базу не назвали.
  return rows.every((row) => Boolean(row[0]?.trim()) && row[0] !== "База данных");
}

/**
 * Каждая карточная страница матрицы отчиталась о нарисованном.
 *
 * Правило «выброшенное рендерером содержимое поднимает
 * CONTENT_DROPPED_BY_RENDERER» исполняется только там, куда поступает
 * телеметрия. Карточная сетка матрицы записей не писала — и страница теряла
 * тему при зелёной приёмке. Отсутствие записи (или самой телеметрии) — отказ,
 * а не пропуск: проверка без входа выглядит ровно так же, как пройденная,
 * поэтому и дека без страниц матрицы считается непроверенной.
 */
export function riskMatrixTelemetryPresent(
  rendererSlides: ReadonlyArray<{ template?: string; pageNumber?: number }>,
  telemetry: { entries?: Array<Record<string, unknown>> } | null | undefined
): boolean {
  const riskPages = rendererSlides
    .filter((s) => String(s.template ?? "").startsWith("orion_golden_risk_matrix"))
    .map((s) => s.pageNumber);
  if (riskPages.length === 0) return false;
  const reported = new Set(
    (telemetry?.entries ?? [])
      .filter((e) => String(e.name ?? "").startsWith("orion_risk_matrix"))
      .map((e) => Number(e.page))
  );
  return riskPages.every((page) => reported.has(Number(page)));
}

/**
 * Страницы регионов несут строку о чтении в полезной нагрузке рендерера.
 *
 * Носитель фразы — `statusNote`, и он проходит длинную цепочку: построитель →
 * пакет → ассемблер → полезная нагрузка → лист. На живом прогоне 76 фраза
 * умирала в середине этой цепочки молча, поэтому проверяется именно то, что
 * получает рендерер. Отсутствие поля — провал, а не пропуск: страница региона
 * без слов о чтении выглядит ровно так же, как страница, где чтения не было.
 */
export function regionalPagesCarryReadingStatus(
  finalSlides: ReadonlyArray<Record<string, unknown>>
): boolean {
  const pages = finalSlides.filter(
    (s) =>
      String(s.template ?? "") === "orion_golden_metrics_dashboard" &&
      /_summary$/u.test(String(s.baseSlotId ?? "")) &&
      s.isContinuation !== true
  );
  if (pages.length === 0) return false;
  return pages.every((s) => /прочитан|читал/iu.test(String(s.statusNote ?? "")));
}

/**
 * Текст страницы проверки Википедии доехал до PDF.
 *
 * Ровно этот зазор «payload → PDF» пропустил регресс при 22 зелёных воротах:
 * методология лежала в полезной нагрузке целиком, а на листе её не было —
 * ножницы рендерера вернули на длинном буллете пустую строку. Сверяется голова
 * нарратива слайда с текстом **той** страницы PDF, где он стоит.
 *
 * Сравнение — без пробелов и пунктуации: fitz рвёт строки и переносит слова, и
 * подстрока «в лоб» дала бы ложный провал. Продолжения не проверяются: нарратив
 * принадлежит первой странице блока, и требовать его голову с каждой страницы
 * шаблона значило бы валить приёмку на здоровой деке с пятью строками выдачи.
 */
export function wikipediaCheckTextInPdf(
  rendererSlides: ReadonlyArray<{
    template?: string;
    pageNumber?: number;
    narrative?: string;
    isContinuation?: boolean;
  }>,
  pageText: (pageNumber: number) => string
): boolean {
  const slides = rendererSlides.filter(
    (s) => s.template === "orion_golden_wikipedia_check" && !s.isContinuation
  );
  if (slides.length === 0) return false;
  return slides.every((s) => {
    const head = String(s.narrative ?? "").split(/(?<=[.!?])\s/u)[0] ?? "";
    if (head.length < 40) return false;
    return compactForCompare(pageText(Number(s.pageNumber))).includes(compactForCompare(head));
  });
}

/** Одна форма для сверки с текстом PDF: буквы и цифры, без пробелов. */
function compactForCompare(text: string): string {
  return normalizeForCompare(text).replace(/\s+/gu, "");
}

/**
 * Ворота, которые не пройдены.
 *
 * Пустой набор ворот — тоже отказ: «0 провалено из 0» неотличимо от «не
 * проверяли», а это ровно тот исход, ради которого писался раннер смоков.
 */
export function failedAcceptanceGates(gates: Record<string, boolean>): string[] {
  const names = Object.keys(gates);
  if (names.length === 0) return ["<ворота не вычислены>"];
  return names.filter((k) => gates[k] !== true);
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
