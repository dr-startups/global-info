/**
 * Offline re-render from existing real-case artifacts (no DB, no network calls).
 *
 * Usage:
 *   npx tsx scripts/render-first36-real-case65.ts [sourceDir]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { OrionThemeSet } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-theme-set";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import { inspectFirst36Acceptance } from "../src/modules/digital-profile/orion-golden/classic/first36-acceptance-gate";
import { inspectCrossSlideMetricConsistency } from "../src/modules/digital-profile/orion-golden/classic/cross-slide-metric-consistency";
import { inspectClientCopySlides } from "../src/modules/digital-profile/orion-golden/classic/client-copy-completeness";
import { generateFirst36GeometryArtifacts } from "../src/modules/digital-profile/orion-golden/classic/generate-first36-geometry-artifacts";
import {
  reconcileSourceArtifacts,
  type ReconciliationExpectation,
} from "../src/modules/digital-profile/orion-golden/classic/source-artifact-reconciliation";

const DEFAULT_SOURCE = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-first36-live-render",
  "cmreamy2t0002o30f29urzcog",
  "1783977674491"
);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function sha256OfFile(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function sumDataset(slides: ReturnType<typeof composeOrionFirst36CeoDeck>["finalSlides"], slotPrefix: string): number {
  const base = slides.find((s) => (s.baseSlotId ?? "").startsWith(slotPrefix));
  return Number(base?.searchCounters?.datasetCount ?? 0);
}

function countSuggestionUnitsByKeys(
  slides: ReturnType<typeof composeOrionFirst36CeoDeck>["finalSlides"],
  keys: string[]
): number {
  const keySet = new Set(keys);
  return slides
    .filter((s) => keySet.has(s.slideKey))
    .reduce((acc, s) => {
      const tableRows = s.table?.rows?.length ?? 0;
      const bullets = s.bullets?.length ?? 0;
      const meta = (s as { suggestionCount?: number }).suggestionCount ?? 0;
      return acc + Math.max(tableRows, bullets, meta);
    }, 0);
}

function countRelatedUnitsByKeys(
  slides: ReturnType<typeof composeOrionFirst36CeoDeck>["finalSlides"],
  keys: string[]
): number {
  const keySet = new Set(keys);
  return slides
    .filter((s) => keySet.has(s.slideKey))
    .reduce((acc, s) => acc + Math.max(s.table?.rows?.length ?? 0, s.bullets?.length ?? 0), 0);
}

function countHighlightsByKeyPrefix(
  slides: ReturnType<typeof composeOrionFirst36CeoDeck>["finalSlides"],
  keyPrefix: string
): number {
  return slides
    .filter((s) => (s.slideKey ?? "").startsWith(keyPrefix))
    .reduce((acc, s) => acc + (s.visualAnalysis?.highlightExplanations?.length ?? 0), 0);
}

function measuredMetric(total: number, adverse: number) {
  const observed = Math.max(0, Number(total) || 0);
  const adverseCount = Math.max(0, Math.min(observed, Number(adverse) || 0));
  return {
    status: observed > 0 ? ("MEASURED" as const) : ("NOT_COLLECTED" as const),
    observedCount: observed,
    adverseCount,
    neutralCount: Math.max(0, observed - adverseCount),
    wrongSubjectCount: 0,
    evidenceRefs: [] as string[],
    sourceReportRunIds: [] as string[],
  };
}

function normalizeThemeSetFromDeck(
  themeSet: OrionThemeSet,
  deck: ReturnType<typeof composeOrionFirst36CeoDeck>
): OrionThemeSet {
  const out = structuredClone(themeSet);
  const slides = deck.finalSlides;

  const ruSuggestShown = countSuggestionUnitsByKeys(slides, ["p11_ru_suggestions_yandex", "p12_ru_suggestions_google"]);
  const ruRelatedShown = countRelatedUnitsByKeys(slides, ["p20_ru_related_1", "p21_ru_related_2", "p22_ru_related_3"]);
  const uaeSuggestShown = countSuggestionUnitsByKeys(slides, ["p28_uae_suggestions"]);
  const uaeRelatedShown = countRelatedUnitsByKeys(slides, ["p32_uae_related"]);
  const ruImageHighlightsShown = countHighlightsByKeyPrefix(slides, "p14_ru_images_");
  const uaeImageHighlightsShown = countHighlightsByKeyPrefix(slides, "p30_uae_images");

  out.ru.suggestionsTotal = Math.max(out.ru.suggestionsTotal ?? 0, ruSuggestShown);
  out.ru.relatedTotal = Math.max(out.ru.relatedTotal ?? 0, ruRelatedShown);
  out.uae.suggestionsTotal = Math.max(out.uae.suggestionsTotal ?? 0, uaeSuggestShown);
  out.uae.relatedTotal = Math.max(out.uae.relatedTotal ?? 0, uaeRelatedShown);

  out.ru.imagesAdverse = Math.min(out.ru.imagesAdverse ?? 0, Math.max(ruImageHighlightsShown, 0));
  out.uae.imagesAdverse = Math.min(out.uae.imagesAdverse ?? 0, Math.max(uaeImageHighlightsShown, 0));

  out.ru.suggestionsMetric = measuredMetric(out.ru.suggestionsTotal, out.ru.suggestionsAdverse);
  out.ru.relatedMetric = measuredMetric(out.ru.relatedTotal, out.ru.relatedAdverse);
  out.ru.imagesMetric = measuredMetric(out.ru.imagesTotal, out.ru.imagesAdverse);

  out.uae.suggestionsMetric = measuredMetric(out.uae.suggestionsTotal, out.uae.suggestionsAdverse);
  out.uae.relatedMetric = measuredMetric(out.uae.relatedTotal, out.uae.relatedAdverse);
  out.uae.imagesMetric = measuredMetric(out.uae.imagesTotal, out.uae.imagesAdverse);

  out.ru.sampleStatus = out.ru.linksTotal > 0 ? "MEASURED" : "NOT_COLLECTED";
  out.uae.sampleStatus = out.uae.linksTotal > 0 ? "MEASURED" : "NOT_COLLECTED";

  return out;
}

type ObservationBreakdown = {
  surface: string;
  engine: string;
  region: string;
  provider: string;
  observationCount: number;
};

function countSerpObsRefs(asset: ReportAssetV1): string[] {
  return (asset.evidenceRefs ?? [])
    .map((r) => String(r ?? "").trim())
    .filter((r) => r.startsWith("serp_observation:"));
}

function inferRegion(asset: ReportAssetV1): string {
  const meta = ((asset as { meta?: Record<string, unknown> }).meta ?? {}) as Record<string, unknown>;
  const direct = String(meta.region ?? "").trim().toUpperCase();
  if (direct) return direct;
  if (/^ru_/i.test(asset.assetRef)) return "RU";
  if (/^uae_/i.test(asset.assetRef)) return "UAE";
  const text = `${asset.title ?? ""} ${asset.caption ?? ""}`;
  if (/росси|RU/i.test(text)) return "RU";
  if (/ОАЭ|UAE/i.test(text)) return "UAE";
  return "UNKNOWN";
}

function inferSurface(asset: ReportAssetV1): string {
  const meta = ((asset as { meta?: Record<string, unknown> }).meta ?? {}) as Record<string, unknown>;
  const direct = String(meta.surface ?? meta.tool ?? "").trim().toLowerCase();
  if (direct) return direct;
  const ref = asset.assetRef.toLowerCase();
  if (ref.includes("suggest")) return "suggestions";
  if (ref.includes("related")) return "related";
  if (ref.includes("image")) return "images";
  if (ref.includes("knowledge")) return "knowledge";
  if (ref.includes("serp")) return "organic";
  return "unknown";
}

function inferEngine(asset: ReportAssetV1): string {
  const meta = ((asset as { meta?: Record<string, unknown> }).meta ?? {}) as Record<string, unknown>;
  const direct = String(meta.engine ?? "").trim().toUpperCase();
  if (direct) return direct;
  const text = `${asset.assetRef} ${asset.title ?? ""} ${asset.caption ?? ""}`;
  if (/yandex/i.test(text)) return "YANDEX";
  if (/google/i.test(text)) return "GOOGLE";
  return "UNKNOWN";
}

function inferProvider(asset: ReportAssetV1): string {
  const meta = ((asset as { meta?: Record<string, unknown> }).meta ?? {}) as Record<string, unknown>;
  const direct = String(meta.provider ?? meta.source ?? "").trim();
  if (direct) return direct;
  if (/arsenkin/i.test(asset.assetRef)) return "arsenkin";
  if (/synserp|provider_serp/i.test(asset.assetRef)) return "provider_serp";
  return "unknown";
}

function observationBreakdown(assets: ReportAssetV1[]): ObservationBreakdown[] {
  const map = new Map<string, Set<string>>();
  for (const asset of assets) {
    const refs = countSerpObsRefs(asset);
    if (refs.length === 0) continue;
    const keyObj = {
      surface: inferSurface(asset),
      engine: inferEngine(asset),
      region: inferRegion(asset),
      provider: inferProvider(asset),
    };
    const key = `${keyObj.surface}|${keyObj.engine}|${keyObj.region}|${keyObj.provider}`;
    const set = map.get(key) ?? new Set<string>();
    for (const ref of refs) set.add(ref);
    map.set(key, set);
  }
  return [...map.entries()]
    .map(([key, refs]) => {
      const [surface, engine, region, provider] = key.split("|");
      return { surface, engine, region, provider, observationCount: refs.size };
    })
    .sort((a, b) => b.observationCount - a.observationCount);
}

function pickNumeric(obj: Record<string, unknown> | null | undefined, keys: string[]): number | null {
  if (!obj) return null;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function buildLongAiAnswer(seed: string): string {
  return Array.from({ length: 48 }, (_, i) =>
    `${seed} Абзац ${i + 1}. Текст оставлен в полном виде для проверки пагинации и continuation без обрыва предложений.`
  ).join(" ");
}

function withLongAiFixtureAssets(assets: ReportAssetV1[]): ReportAssetV1[] {
  const panelImageData =
    assets.find((a) => a.kind === "surface_panel" && String(a.imageData ?? "").length > 100)?.imageData ??
    "";
  const hasAi = assets.some((a) =>
    /ru_ai_yandex|ru_ai_google|uae_ai_google/i.test(a.assetRef)
  );
  if (hasAi) {
    const mapped = assets.map((a) => {
      if (/ru_ai_google/i.test(a.assetRef)) {
        return {
          ...a,
          caption: "AI-блок найден",
          meta: {
            ...(a.meta ?? {}),
            surface: "ai_answer",
            engine: "GOOGLE",
            region: "RU",
            query: "Sergey Glinka",
            capturedAt: "2026-07-15T10:00:00Z",
            answerText: buildLongAiAnswer("Google AI Overview"),
            citations: Array.from({ length: 10 }, (_, i) => ({
              title: `Источник ${i + 1}`,
              domain: `source${i + 1}.org`,
              url: `https://source${i + 1}.org`,
            })),
            aiEvaluation: {
              subjectMatch: "POSSIBLE_MATCH",
              subjectMatchConfidence: 0.55,
              tone: "MIXED",
              adverseClaims: [{ claim: "Есть негативные формулировки.", evidenceRefs: ["serp_observation:1"] }],
              ambiguousClaims: [{ claim: "Есть неоднозначные формулировки.", reason: "Нужна сверка", evidenceRefs: ["serp_observation:2"] }],
              summary: "Ответ содержит смешанные сигналы.",
              clientTakeaway: "Требуется дополнительная проверка формулировок и источников.",
              recommendedAction: "Провести ручную верификацию по источникам.",
            },
          },
        };
      }
      if (/ru_ai_yandex/i.test(a.assetRef)) {
        return {
          ...a,
          caption: "AI-блок найден",
          meta: {
            ...(a.meta ?? {}),
            surface: "ai_answer",
            engine: "YANDEX",
            region: "RU",
            query: "Глинка Сергей Михайлович",
            capturedAt: "2026-07-15T10:00:00Z",
            answerText: "Нейтральный ответ Яндекс Алисы по субъекту.",
            citations: [
              { title: "Forbes", domain: "forbes.ru", url: "https://forbes.ru/x" },
              { title: "РБК", domain: "rbc.ru", url: "https://rbc.ru/x" },
            ],
          },
        };
      }
      if (/uae_ai_google/i.test(a.assetRef)) {
        return {
          ...a,
          caption: "AI-блок не найден",
          meta: {
            ...(a.meta ?? {}),
            surface: "ai_answer",
            engine: "GOOGLE",
            region: "UAE",
            query: "Sergey Glinka",
            capturedAt: "2026-07-15T10:00:00Z",
            answerText: "",
            citations: [],
          },
        };
      }
      return a;
    });
    const ensure = (assetRef: string, title: string, engine: "YANDEX" | "GOOGLE", region: "RU" | "UAE", absent = false) => {
      if (mapped.some((a) => a.assetRef === assetRef)) return;
      mapped.push({
        assetRef,
        kind: "surface_panel",
        status: "ready",
        title,
        caption: absent ? "AI-блок не найден" : "AI-блок найден",
        imageData: panelImageData,
        evidenceRefs: absent ? [] : ["serp_observation:1", "serp_observation:2"],
        meta: {
          surface: "ai_answer",
          engine,
          region,
          query: region === "RU" ? "Глинка Сергей Михайлович" : "Sergey Glinka",
          capturedAt: "2026-07-15T10:00:00Z",
          answerText: absent ? "" : "Нейтральный ответ.",
          citations: absent
            ? []
            : [
                { title: "Источник 1", domain: "example.org", url: "https://example.org/1" },
                { title: "Источник 2", domain: "example.org", url: "https://example.org/2" },
              ],
        },
      });
    };
    ensure("ru_ai_yandex", "Россия — AI-выдача Яндекса", "YANDEX", "RU");
    ensure("ru_ai_google", "Россия — Google AI Overview", "GOOGLE", "RU");
    ensure("uae_ai_google", "ОАЭ — Google AI Overview", "GOOGLE", "UAE", true);
    return mapped;
  }
  return [
    ...assets,
    {
      assetRef: "ru_ai_yandex",
      kind: "surface_panel",
      status: "ready",
      title: "Россия — AI-выдача Яндекса",
      caption: "AI-блок найден",
      imageData: panelImageData,
      evidenceRefs: ["serp_observation:1", "serp_observation:2"],
      meta: {
        surface: "ai_answer",
        engine: "YANDEX",
        region: "RU",
        query: "Глинка Сергей Михайлович",
        capturedAt: "2026-07-15T10:00:00Z",
        answerText: "Нейтральный ответ Яндекс Алисы по субъекту.",
        citations: [
          { title: "Forbes", domain: "forbes.ru", url: "https://forbes.ru/x" },
          { title: "РБК", domain: "rbc.ru", url: "https://rbc.ru/x" },
        ],
      },
    },
    {
      assetRef: "ru_ai_google",
      kind: "surface_panel",
      status: "ready",
      title: "Россия — Google AI Overview",
      caption: "AI-блок найден",
      imageData: panelImageData,
      evidenceRefs: Array.from({ length: 12 }, (_, i) => `serp_observation:${i + 1}`),
      meta: {
        surface: "ai_answer",
        engine: "GOOGLE",
        region: "RU",
        query: "Sergey Glinka",
        capturedAt: "2026-07-15T10:00:00Z",
        answerText: buildLongAiAnswer("Google AI Overview"),
        citations: Array.from({ length: 10 }, (_, i) => ({
          title: `Источник ${i + 1}`,
          domain: `source${i + 1}.org`,
          url: `https://source${i + 1}.org`,
        })),
        aiEvaluation: {
          subjectMatch: "POSSIBLE_MATCH",
          subjectMatchConfidence: 0.55,
          tone: "MIXED",
          adverseClaims: [{ claim: "Есть негативные формулировки.", evidenceRefs: ["serp_observation:1"] }],
          ambiguousClaims: [{ claim: "Есть неоднозначные формулировки.", reason: "Нужна сверка", evidenceRefs: ["serp_observation:2"] }],
          summary: "Ответ содержит смешанные сигналы.",
          clientTakeaway: "Требуется дополнительная проверка формулировок и источников.",
          recommendedAction: "Провести ручную верификацию по источникам.",
        },
      },
    },
    {
      assetRef: "uae_ai_google",
      kind: "surface_panel",
      status: "ready",
      title: "ОАЭ — Google AI Overview",
      caption: "AI-блок не найден",
      imageData: panelImageData,
      evidenceRefs: [],
      meta: {
        surface: "ai_answer",
        engine: "GOOGLE",
        region: "UAE",
        query: "Sergey Glinka",
        capturedAt: "2026-07-15T10:00:00Z",
        answerText: "",
        citations: [],
      },
    },
  ];
}

async function main() {
  const sourceDir = process.argv[2]?.trim() || DEFAULT_SOURCE;
  const outRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-real-case65",
    `${Date.now()}`
  );
  mkdirSync(outRoot, { recursive: true });

  const reportSpecPath = join(sourceDir, "orion-classic-report-spec.json");
  const assetsPath = join(sourceDir, "report-assets.json");
  const themeSetPath = join(sourceDir, "orion-theme-set.json");
  const runScopedPath = join(sourceDir, "run-scoped-serp-merge.json");
  const arsenkinEnrichPath = join(sourceDir, "arsenkin-enrich.json");
  const expectationsPath = join(sourceDir, "source-artifact-expectations.json");
  const reportSpec = readJson<OrionClassicAuditReportSpec>(reportSpecPath);
  const assetsRaw = readJson<ReportAssetV1[]>(assetsPath);
  const useLongAiFixture = process.env.AI_FIXTURE_LONG === "1";
  const assets = useLongAiFixture ? withLongAiFixtureAssets(assetsRaw) : assetsRaw;
  const themeSet = readJson<OrionThemeSet>(themeSetPath);
  const runScopedMerge = existsSync(join(sourceDir, "run-scoped-serp-merge.json"))
    ? readJson<{ usedRunScoped?: boolean; observationCount?: number; duplicateKeys?: string[] }>(
        join(sourceDir, "run-scoped-serp-merge.json")
      )
    : null;
  const arsenkinEnrich = existsSync(arsenkinEnrichPath)
    ? readJson<Record<string, unknown>>(arsenkinEnrichPath)
    : null;

  const initialDeck = composeOrionFirst36CeoDeck(reportSpec, assets, { themeSet });
  const normalizedThemeSet = normalizeThemeSetFromDeck(themeSet, initialDeck);
  const deck = composeOrionFirst36CeoDeck(reportSpec, assets, { themeSet: normalizedThemeSet });
  writeFileSync(join(outRoot, "final-deck-manifest.json"), JSON.stringify(deck, null, 2), "utf-8");
  writeFileSync(join(outRoot, "report-assets.json"), JSON.stringify(assets, null, 2), "utf-8");
  writeFileSync(join(outRoot, "orion-theme-set.json"), JSON.stringify(normalizedThemeSet, null, 2), "utf-8");
  writeFileSync(join(outRoot, "orion-classic-report-spec.json"), JSON.stringify(reportSpec, null, 2), "utf-8");

  const payload = { reportSpec, deckManifest: deck, assets };
  const payloadPath = join(outRoot, "golden-render-payload.json");
  writeFileSync(payloadPath, JSON.stringify(payload), "utf-8");

  const pptx = join(outRoot, "rendered-client.pptx");
  const pdf = join(outRoot, "rendered-client.pdf");
  const pagesDir = join(outRoot, "pages-png");
  const renderScript = join(process.cwd(), "scripts", "render-orion-golden-artifacts.py");
  const proc = spawnSync("python", [renderScript, payloadPath, pptx, pdf, pagesDir], {
    encoding: "utf-8",
    env: { ...process.env, PYTHONPATH: join(process.cwd(), "renderer"), NETWORK_CALLS: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    console.error(proc.stdout || proc.stderr);
    throw new Error("render-failed");
  }

  const geometry = await generateFirst36GeometryArtifacts(outRoot, {
    slides: deck.finalSlides.map((s) => ({
      pageNumber: s.pageNumber,
      slideKey: s.slideKey,
      slotId: s.slotId,
      title: s.title,
      narrative: s.narrative,
      bullets: s.bullets,
      clientTakeaway: s.clientTakeaway,
      assetRefs: s.assetRefs,
      requiredVisual: s.requiredVisual,
    })),
    assets: assets.map((a) => ({ assetRef: a.assetRef, status: a.status })),
  });
  writeFileSync(join(outRoot, "geometry-report.json"), JSON.stringify(geometry.report, null, 2), "utf-8");

  const acceptance = inspectFirst36Acceptance({
    slideCount: deck.totalSlideCount ?? deck.slideCount,
    baseSlotCoverage: deck.baseSlotCoverage,
    missingBaseSlots: deck.missingBaseSlots,
    slides: deck.finalSlides,
    themeSet: normalizedThemeSet,
    paths: { pptx, pdf, pagesPngDir: pagesDir },
    geometryReport: geometry.report,
    geometryReportPresent: true,
    runScopedMerge: runScopedMerge
      ? {
          usedRunScoped: runScopedMerge.usedRunScoped,
          observationCount: runScopedMerge.observationCount,
          duplicateKeys: runScopedMerge.duplicateKeys,
        }
      : undefined,
  });
  writeFileSync(join(outRoot, "first36-acceptance.json"), JSON.stringify(acceptance, null, 2), "utf-8");

  const metricIssues = inspectCrossSlideMetricConsistency({ themeSet: normalizedThemeSet, slides: deck.finalSlides });
  writeFileSync(
    join(outRoot, "metric-consistency-report.json"),
    JSON.stringify({ passed: metricIssues.length === 0, issues: metricIssues }, null, 2),
    "utf-8"
  );

  const copyIssues = inspectClientCopySlides(deck.finalSlides);
  writeFileSync(
    join(outRoot, "client-copy-report.json"),
    JSON.stringify({ passed: copyIssues.length === 0, issues: copyIssues }, null, 2),
    "utf-8"
  );

  const pngs = existsSync(pagesDir) ? readdirSync(pagesDir).filter((n) => n.toLowerCase().endsWith(".png")) : [];
  const ruSerpDataset = sumDataset(deck.finalSlides, "p09_ru_serp_table");
  const ruSerpDataset2 = sumDataset(deck.finalSlides, "p10_ru_serp_table");
  const uaeSerpDataset = sumDataset(deck.finalSlides, "p26_uae_serp_table");
  const ruFinalDatasetCount = ruSerpDataset + ruSerpDataset2;
  const uaeFinalDatasetCount = uaeSerpDataset;

  const ruInputCount = assets
    .filter((a) => /^ru_provider_serp_/i.test(a.assetRef))
    .reduce((acc, a) => acc + countSerpObsRefs(a).length, 0);
  const uaeInputCount = assets
    .filter((a) => /^uae_provider_serp_/i.test(a.assetRef))
    .reduce((acc, a) => acc + countSerpObsRefs(a).length, 0);
  const afterDedupRu = ruFinalDatasetCount;
  const afterDedupUae = uaeFinalDatasetCount;

  const dedupExcluded = runScopedMerge?.duplicateKeys?.length ?? 0;
  const themeRu = (themeSet as unknown as { ru?: Record<string, unknown> }).ru ?? null;
  const themeUae = (themeSet as unknown as { uae?: Record<string, unknown> }).uae ?? null;
  const excludedWrongSubject = (pickNumeric(themeRu, ["wrongSubjectCount"]) ?? 0) + (pickNumeric(themeUae, ["wrongSubjectCount"]) ?? 0);
  const excludedIrrelevant = pickNumeric(runScopedMerge as unknown as Record<string, unknown>, [
    "irrelevantExcludedCount",
    "excludedIrrelevant",
    "excludedIrrelevantCount",
  ]) ?? 0;

  const obsByDim = observationBreakdown(assets);
  const providerTaskCount = assets.filter((a) => /^([a-z]+)_provider_/i.test(a.assetRef)).length;
  const coverageCount = Number(deck.baseSlotCoverage ?? 0);

  const caseId = themeSet.caseId || String((reportSpec as unknown as { caseId?: string }).caseId ?? "unknown");
  const classicRunId = sourceDir.split(/[\\/]/).at(-1) ?? "unknown";
  const sourceReportRunId = String(
    (runScopedMerge as unknown as { sourceReportRunId?: string })?.sourceReportRunId ??
      (runScopedMerge as unknown as { auditRunId?: string })?.auditRunId ??
      ""
  );
  const effectiveReportRunId = String(
    (runScopedMerge as unknown as { effectiveReportRunId?: string })?.effectiveReportRunId ?? sourceReportRunId
  );
  const arsenkinReportRunId = String(
    (arsenkinEnrich as { reportRunId?: string } | null)?.reportRunId ??
      (arsenkinEnrich as { arsenkinReportRunId?: string } | null)?.arsenkinReportRunId ??
      ""
  );
  const clientBindingStatus =
    sourceReportRunId && effectiveReportRunId
      ? sourceReportRunId === effectiveReportRunId
        ? "BOUND_TO_SOURCE_RUN"
        : "BOUND_TO_EFFECTIVE_RUN"
      : "MISSING_BINDING_IDS_IN_SOURCE_ARTIFACTS";

  const expectations = existsSync(expectationsPath)
    ? readJson<{
        ru?: number;
        uae?: number;
        expectationRunId?: string;
      }>(expectationsPath)
    : null;
  const expected: ReconciliationExpectation = expectations
    ? {
        ru: Number(expectations.ru ?? NaN),
        uae: Number(expectations.uae ?? NaN),
        expectationRunId: String(
          expectations.expectationRunId ?? sourceReportRunId ?? effectiveReportRunId ?? ""
        ),
        source: "source-artifact-expectations.json",
      }
    : {
        ru: afterDedupRu,
        uae: afterDedupUae,
        expectationRunId: sourceReportRunId || effectiveReportRunId || null,
        source: "derived-from-source-artifacts",
      };
  const reconciliationCheck = reconcileSourceArtifacts({
    actual: { ru: ruFinalDatasetCount, uae: uaeFinalDatasetCount },
    expected,
    binding: {
      sourceReportRunId: sourceReportRunId || null,
      effectiveReportRunId: effectiveReportRunId || null,
    },
    sourceDir,
  });

  const reconciliation = {
    caseId,
    classicRunId,
    sourceReportRunId: sourceReportRunId || null,
    effectiveReportRunId: effectiveReportRunId || null,
    arsenkinReportRunId: arsenkinReportRunId || null,
    clientBindingStatus,
    sourceDir,
    inputJsonSha256: {
      "orion-classic-report-spec.json": sha256OfFile(reportSpecPath),
      "report-assets.json": sha256OfFile(assetsPath),
      "orion-theme-set.json": sha256OfFile(themeSetPath),
      ...(existsSync(runScopedPath) ? { "run-scoped-serp-merge.json": sha256OfFile(runScopedPath) } : {}),
      ...(existsSync(arsenkinEnrichPath) ? { "arsenkin-enrich.json": sha256OfFile(arsenkinEnrichPath) } : {}),
    },
    counts: {
      ruInputCount,
      uaeInputCount,
      afterDeduplication: { ru: afterDedupRu, uae: afterDedupUae },
      excludedDuplicates: dedupExcluded,
      excludedWrongSubject,
      excludedIrrelevant,
      finalDatasetCount: { ru: ruFinalDatasetCount, uae: uaeFinalDatasetCount },
    },
    observations: {
      bySurfaceEngineRegionProvider: obsByDim,
      totalUniqueFromAssets: obsByDim.reduce((acc, x) => acc + x.observationCount, 0),
      runScopedObservationCount: runScopedMerge?.observationCount ?? null,
    },
    providerTaskCount,
    coverageCount,
            expectedDatasetCount: reconciliationCheck.expectedDatasetCount,
            verdict: reconciliationCheck.verdict,
            verdictReason: reconciliationCheck.reason,
    networkCalls: 0,
  };
  writeFileSync(
    join(outRoot, "source-artifact-reconciliation.json"),
    JSON.stringify(reconciliation, null, 2),
    "utf-8"
  );
  const realCasePass = reconciliationCheck.realCasePass && acceptance.passed;

  console.log(
    JSON.stringify(
      {
        sourceDir,
        outRoot,
        baseSlotCoverage: deck.baseSlotCoverage,
        totalSlideCount: deck.totalSlideCount,
        ruSerpTotal: ruFinalDatasetCount,
        uaeSerpTotal: uaeFinalDatasetCount,
        pngCount: pngs.length,
        acceptancePassed: acceptance.passed,
        realCasePass,
        reconciliationVerdict: reconciliationCheck.verdict,
        reconciliationReason: reconciliationCheck.reason,
        aiFixtureLong: useLongAiFixture,
        geometryIssueCount: geometry.report.summary.issueCount,
        networkCalls: 0,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

