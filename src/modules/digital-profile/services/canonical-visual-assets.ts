/**
 * Canonical job-scoped visual assets for the unified ORION report.
 *
 * Builds synthetic, API-derived visuals (ORION style) from the SAME composite
 * inventory the analytics pipeline consumes — deterministic, offline, no DB,
 * no network. Every asset carries the evidenceRefs of the rows actually drawn
 * on it plus per-row visibleItems (with the same red-frame highlight
 * classifier the legacy report-72 snapshots used), so deck sidebars can
 * explain exactly what the client sees.
 *
 * Produced assets and their canonical slot binding:
 *   - synthetic SERP snapshots (RU / UAE)        → p10 / p27
 *   - suggestion panels (Yandex / Google / UAE)  → p11 / p12 / p28
 *   - related-queries (PAA) panels               → p20–p22 / p32
 *   - AI answers / knowledge panels              → p18 / p19 / p31
 *   - image grids                                → p14–p17 / p30
 */

import type { RawInventoryItem } from "../orion-golden/types";
import type {
  VisibleAssetItem,
  VisualAssetMeta,
  VisualAssetsBySlot,
} from "../orion-golden/deck-sections/canonical-slots";
import type { RendererAssetEntry } from "../orion-golden/deck-sections/run-deck-build";
import { renderSerpSnapshotPng } from "../serp-snapshot/renderer";
import { buildSyntheticSerpViewModelFromObservations } from "../serp-observation/synthetic-asset";
import {
  filterObservationsForSyntheticSerp,
} from "../serp-observation/filter-synthetic-serp-noise";
import {
  selectVisibleObservationsForEngine,
} from "../serp-observation/synthetic-asset";
import { classifyObservationHighlight } from "../serp-observation/resolve-observation-highlights";
import type { PersistedSerpObservation } from "../serp-observation/types";
import {
  buildImageGridSvg,
  buildKnowledgePanelSvg,
  buildSurfacePanelSvg,
  svgToPngBase64,
} from "../orion-report-spec/media-asset-svg";
import { mapSurfaceBucket } from "../orion-golden/classic/composite-serp-overlay-merge";

export type CanonicalVisualAssets = {
  assets: RendererAssetEntry[];
  visualAssets: VisualAssetsBySlot;
  /** Counts for diagnostics / summary artifacts. */
  counts: {
    serpSnapshots: number;
    suggestionPanels: number;
    relatedPanels: number;
    aiPanels: number;
    imageGrids: number;
  };
};

type Region = "RU" | "UAE";

function regionOf(raw: string | undefined): Region {
  const r = String(raw ?? "").toUpperCase();
  return /UAE|AE|INTL|EN|GLOBAL/.test(r) ? "UAE" : "RU";
}

function engineOf(item: RawInventoryItem): "YANDEX" | "GOOGLE" | null {
  const raw = String(
    (item.rawMetadata as Record<string, unknown> | undefined)?.engine ?? item.provider ?? ""
  ).toUpperCase();
  if (/YANDEX|\bYA\b/.test(raw)) return "YANDEX";
  if (/GOOGLE|SERPER|GSEARCH/.test(raw)) return "GOOGLE";
  return null;
}

function surfaceOf(item: RawInventoryItem): string {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  return mapSurfaceBucket(String(meta.surface ?? item.evidenceType ?? "organic"));
}

function refOf(item: RawInventoryItem): string {
  return `inventory:${item.inventoryId}`;
}

function domainOf(url: string | undefined): string {
  if (!url || !/^https?:\/\//i.test(url)) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Adapt an inventory item to the shape the SERP snapshot generator consumes. */
function toSerpObservation(item: RawInventoryItem, rank: number): PersistedSerpObservation {
  const engine = engineOf(item) ?? "GOOGLE";
  const region = regionOf(item.region);
  return {
    id: refOf(item),
    searchDocumentId: null,
    caseId: item.caseId,
    auditRunId: item.reportRunId,
    queryId: "composite",
    queryText: item.query ?? "",
    provider: /arsenkin/i.test(item.provider) ? "arsenkin" : engine === "YANDEX" ? "yandex" : "serper",
    engine,
    surface: "organic",
    region,
    language: region === "UAE" ? "en" : "ru",
    rank,
    url: item.sourceUrl ?? "",
    title: item.title ?? null,
    snippet: item.snippet ?? null,
    domain: domainOf(item.sourceUrl) || null,
    providerStatus: "OK",
    capturedAt: new Date(item.collectedAt || 0),
  };
}

function toVisibleItem(item: RawInventoryItem): VisibleAssetItem {
  const hl = classifyObservationHighlight({
    url: item.sourceUrl ?? null,
    domain: domainOf(item.sourceUrl) || null,
    title: item.title ?? null,
    snippet: item.snippet ?? null,
  } as unknown as PersistedSerpObservation);
  return {
    ref: refOf(item),
    url: item.sourceUrl,
    domain: domainOf(item.sourceUrl) || undefined,
    title: item.title,
    engine: engineOf(item) ?? undefined,
    region: regionOf(item.region),
    adverse: hl.isHighlighted,
    themeTitle: hl.themeTitle ?? undefined,
  };
}

function meta(
  asset: RendererAssetEntry,
  visibleItems: VisibleAssetItem[]
): VisualAssetMeta {
  const evidenceRefs = visibleItems.map((v) => v.ref);
  const evidenceDomains = [
    ...new Set(visibleItems.map((v) => v.domain).filter((d): d is string => Boolean(d))),
  ];
  return {
    assetRef: asset.assetRef,
    kind: String(asset.kind ?? "visual"),
    title: String(asset.title ?? asset.assetRef),
    hasImage: Boolean(asset.imageData),
    evidenceRefs,
    evidenceDomains: evidenceDomains.length ? evidenceDomains : undefined,
    visibleItems,
  };
}

/** Most frequent non-empty query among rows (stable tie-break by first seen). */
function dominantQuery(items: RawInventoryItem[], fallback: string): string {
  const counts = new Map<string, number>();
  for (const it of items) {
    const q = String(it.query ?? "").trim();
    if (!q) continue;
    counts.set(q, (counts.get(q) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [q, c] of counts) {
    if (c > bestCount) {
      best = q;
      bestCount = c;
    }
  }
  return best || fallback;
}

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function buildSerpSnapshotAsset(input: {
  assetRef: string;
  region: Region;
  subjectName: string;
  items: RawInventoryItem[];
  bind: (slotId: string, meta: VisualAssetMeta) => void;
  push: (asset: RendererAssetEntry) => void;
  slotId: string;
}): Promise<boolean> {
  // Only engine-attributable rows can appear in a Yandex/Google column.
  const attributable = input.items.filter((it) => engineOf(it) !== null && it.sourceUrl);
  if (attributable.length === 0) return false;

  const rankByEngine = new Map<string, number>();
  const observations = attributable.map((it) => {
    const engine = engineOf(it)!;
    const rank = (rankByEngine.get(engine) ?? 0) + 1;
    rankByEngine.set(engine, rank);
    return { item: it, obs: toSerpObservation(it, rank) };
  });

  const allObs = observations.map((o) => o.obs);
  const filtered = filterObservationsForSyntheticSerp(allObs, input.subjectName);
  const visibleIds = new Set(
    [
      ...selectVisibleObservationsForEngine(filtered, "YANDEX"),
      ...selectVisibleObservationsForEngine(filtered, "GOOGLE"),
    ].map((o) => o.id)
  );
  if (visibleIds.size === 0) return false;

  const vm = buildSyntheticSerpViewModelFromObservations({
    observations: allObs,
    subjectName: input.subjectName,
    queryText: dominantQuery(attributable, input.subjectName),
    language: input.region === "UAE" ? "en" : "ru",
  });
  const png = await renderSerpSnapshotPng(vm);

  const visibleItems = observations
    .filter((o) => visibleIds.has(o.obs.id))
    .map((o) => toVisibleItem(o.item));
  const asset: RendererAssetEntry = {
    assetRef: input.assetRef,
    kind: "serp_screenshot",
    title:
      input.region === "UAE"
        ? "ОАЭ — синтетический снимок выдачи"
        : "Россия — синтетический снимок выдачи",
    caption: "Синтетический снимок на основе сохранённых результатов API",
    imageData: png.toString("base64"),
    evidenceRefs: visibleItems.map((v) => v.ref),
  };
  input.push(asset);
  input.bind(input.slotId, meta(asset, visibleItems));
  return true;
}

async function buildListPanelAsset(input: {
  assetRef: string;
  kind: "surface_panel";
  title: string;
  subtitle: string;
  engineLabel: string;
  caption: string;
  rows: RawInventoryItem[];
  rowMeta?: (item: RawInventoryItem) => string | undefined;
  slotId: string;
  bind: (slotId: string, meta: VisualAssetMeta) => void;
  push: (asset: RendererAssetEntry) => void;
}): Promise<boolean> {
  const rows = input.rows.filter((r) => String(r.title ?? "").trim()).slice(0, 10);
  if (rows.length === 0) return false;
  const visibleItems = rows.map(toVisibleItem);
  const png = await svgToPngBase64(
    buildSurfacePanelSvg({
      title: input.title,
      subtitle: input.subtitle,
      engineLabel: input.engineLabel,
      items: rows.map((r, i) => ({
        label: String(r.title).trim(),
        meta: input.rowMeta?.(r),
        // Same red-frame classifier the SERP snapshot uses: negative phrases
        // are visibly marked on the panel itself (ORION style).
        adverse: visibleItems[i].adverse,
      })),
    })
  );
  const asset: RendererAssetEntry = {
    assetRef: input.assetRef,
    kind: input.kind,
    title: input.title,
    caption: input.caption,
    imageData: png,
    evidenceRefs: visibleItems.map((v) => v.ref),
  };
  input.push(asset);
  input.bind(input.slotId, meta(asset, visibleItems));
  return true;
}

/**
 * Build the full synthetic visual set from composite inventory items.
 * Slots with no matching rows get no asset — the deck renders its honest
 * empty state for them (fail-closed, never fabricated content).
 */
export async function buildCanonicalVisualAssets(input: {
  subjectName: string;
  items: RawInventoryItem[];
}): Promise<CanonicalVisualAssets> {
  const assets: RendererAssetEntry[] = [];
  const visualAssets: VisualAssetsBySlot = {};
  const push = (a: RendererAssetEntry) => assets.push(a);
  const bind = (slotId: string, m: VisualAssetMeta) => {
    (visualAssets[slotId] ??= []).push(m);
  };

  const by = (pred: (it: RawInventoryItem) => boolean) => input.items.filter(pred);
  const counts = {
    serpSnapshots: 0,
    suggestionPanels: 0,
    relatedPanels: 0,
    aiPanels: 0,
    imageGrids: 0,
  };

  // --- Synthetic SERP snapshots (organic) ---------------------------------
  for (const [region, assetRef, slotId] of [
    ["RU", "ru_serp_snapshot", "p10_ru_serp_visual"],
    ["UAE", "uae_serp_snapshot", "p27_uae_serp_visual"],
  ] as const) {
    const ok = await buildSerpSnapshotAsset({
      assetRef,
      region,
      slotId,
      subjectName: input.subjectName,
      items: by((it) => surfaceOf(it) === "organic" && regionOf(it.region) === region),
      bind,
      push,
    });
    if (ok) counts.serpSnapshots += 1;
  }

  // --- Suggestion panels ----------------------------------------------------
  const suggestions = by((it) => surfaceOf(it) === "autocomplete");
  const ruSuggest = suggestions.filter((it) => regionOf(it.region) === "RU");
  const ruYandex = ruSuggest.filter((it) => engineOf(it) === "YANDEX");
  const ruGoogle = ruSuggest.filter((it) => engineOf(it) === "GOOGLE");
  const ruUnattributed = ruSuggest.filter((it) => engineOf(it) === null);
  const uaeSuggest = suggestions.filter((it) => regionOf(it.region) === "UAE");

  const p11Rows = ruYandex.length > 0 ? ruYandex : ruUnattributed;
  const p11Label = ruYandex.length > 0 ? "Яндекс" : "Яндекс / Google";
  if (
    await buildListPanelAsset({
      assetRef: "ru_suggestions_yandex",
      kind: "surface_panel",
      title:
        ruYandex.length > 0
          ? "Россия — поисковые подсказки Яндекса"
          : "Россия — поисковые подсказки",
      subtitle: `${p11Rows.length} строк · собрано через API`,
      engineLabel: p11Label,
      caption: "Автодополнение поисковой строки по запросам о субъекте",
      rows: p11Rows,
      rowMeta: (r) => (r.query ? String(r.query) : p11Label),
      slotId: "p11_ru_suggestions_yandex",
      bind,
      push,
    })
  ) {
    counts.suggestionPanels += 1;
  }
  const p12Rows =
    ruGoogle.length > 0 ? ruGoogle : ruYandex.length > 0 ? ruUnattributed : [];
  if (
    await buildListPanelAsset({
      assetRef: "ru_suggestions_google",
      kind: "surface_panel",
      title:
        ruGoogle.length > 0
          ? "Россия — поисковые подсказки Google"
          : "Россия — поисковые подсказки (дополнительно)",
      subtitle: `${p12Rows.length} строк · собрано через API`,
      engineLabel: ruGoogle.length > 0 ? "Google" : "Яндекс / Google",
      caption: "Автодополнение поисковой строки по запросам о субъекте",
      rows: p12Rows,
      rowMeta: (r) => (r.query ? String(r.query) : undefined),
      slotId: "p12_ru_suggestions_google",
      bind,
      push,
    })
  ) {
    counts.suggestionPanels += 1;
  }
  if (
    await buildListPanelAsset({
      assetRef: "uae_suggestions",
      kind: "surface_panel",
      title: "ОАЭ — поисковые подсказки",
      subtitle: `${uaeSuggest.length} строк · собрано через API`,
      engineLabel: "Google",
      caption: "Автодополнение поисковой строки по запросам о субъекте (международный контур)",
      rows: uaeSuggest,
      rowMeta: (r) => (r.query ? String(r.query) : undefined),
      slotId: "p28_uae_suggestions",
      bind,
      push,
    })
  ) {
    counts.suggestionPanels += 1;
  }

  // --- Related queries / PAA panels ----------------------------------------
  const related = by((it) => surfaceOf(it) === "paa");
  const ruRelated = related.filter((it) => regionOf(it.region) === "RU");
  const uaeRelated = related.filter((it) => regionOf(it.region) === "UAE");
  const ruRelatedChunks = chunk(ruRelated, Math.max(1, Math.ceil(ruRelated.length / 3)));
  const relatedSlots = ["p20_ru_related_1", "p21_ru_related_2", "p22_ru_related_3"];
  for (let i = 0; i < 3; i += 1) {
    const rows = ruRelatedChunks[i] ?? [];
    if (
      await buildListPanelAsset({
        assetRef: `ru_related_${i + 1}`,
        kind: "surface_panel",
        title: `Россия — связанные запросы (${i + 1})`,
        subtitle: `${rows.length} строк · собрано через API`,
        engineLabel: "Связанные запросы / PAA",
        caption: "Вопросы и запросы, которые поиск связывает с субъектом",
        rows,
        rowMeta: (r) => (r.snippet ? String(r.snippet).slice(0, 80) : undefined),
        slotId: relatedSlots[i],
        bind,
        push,
      })
    ) {
      counts.relatedPanels += 1;
    }
  }
  if (
    await buildListPanelAsset({
      assetRef: "uae_related",
      kind: "surface_panel",
      title: "ОАЭ — связанные запросы",
      subtitle: `${uaeRelated.length} строк · собрано через API`,
      engineLabel: "Связанные запросы / PAA",
      caption: "Вопросы и запросы, которые поиск связывает с субъектом (международный контур)",
      rows: uaeRelated,
      rowMeta: (r) => (r.snippet ? String(r.snippet).slice(0, 80) : undefined),
      slotId: "p32_uae_related",
      bind,
      push,
    })
  ) {
    counts.relatedPanels += 1;
  }

  // --- AI answers / knowledge panels ----------------------------------------
  const aiRows = by((it) => {
    const s = surfaceOf(it);
    return s === "ai_answer" || s === "knowledge_block";
  });
  const ruAi = aiRows.filter((it) => regionOf(it.region) === "RU");
  const uaeAi = aiRows.filter((it) => regionOf(it.region) === "UAE");

  const buildAiPanel = async (
    rows: RawInventoryItem[],
    assetRef: string,
    slotId: string,
    title: string
  ): Promise<boolean> => {
    const answer = rows.find((r) => String(r.snippet ?? "").trim());
    if (!answer && rows.length === 0) return false;
    const facts = rows
      .filter((r) => r !== answer)
      .slice(0, 4)
      .map((r) => String(r.title ?? r.sourceUrl ?? "").trim())
      .filter(Boolean);
    const png = await svgToPngBase64(
      buildKnowledgePanelSvg({
        title,
        summary: String(answer?.snippet ?? answer?.title ?? "Ответ ИИ-поиска зафиксирован без развёрнутого текста"),
        facts,
      })
    );
    const used = [answer, ...rows.filter((r) => r !== answer).slice(0, 4)].filter(
      (r): r is RawInventoryItem => Boolean(r)
    );
    const visibleItems = used.map(toVisibleItem);
    const asset: RendererAssetEntry = {
      assetRef,
      kind: "knowledge_panel",
      title,
      caption: "Ответ ИИ-поиска по запросам о субъекте (синтетическая карточка на основе API)",
      imageData: png,
      evidenceRefs: visibleItems.map((v) => v.ref),
    };
    push(asset);
    bind(slotId, meta(asset, visibleItems));
    return true;
  };

  if (ruAi.length > 0) {
    if (
      await buildAiPanel(ruAi, "ru_ai_answers", "p19_ru_knowledge_2", "Россия — ИИ-ответы поисковых систем")
    ) {
      counts.aiPanels += 1;
    }
  }
  const ruKnowledge = ruAi.filter((it) => surfaceOf(it) === "knowledge_block");
  if (ruKnowledge.length > 0) {
    if (
      await buildAiPanel(ruKnowledge, "ru_knowledge_panel", "p18_ru_knowledge_1", "Россия — панель знаний поиска")
    ) {
      counts.aiPanels += 1;
    }
  }
  if (uaeAi.length > 0) {
    if (
      await buildAiPanel(uaeAi, "uae_ai_answers", "p31_uae_knowledge", "ОАЭ — панель знаний и AI Overview")
    ) {
      counts.aiPanels += 1;
    }
  }

  // --- Image grids -----------------------------------------------------------
  const images = by((it) => surfaceOf(it) === "images");
  const ruImages = images.filter((it) => regionOf(it.region) === "RU");
  const uaeImages = images.filter((it) => regionOf(it.region) === "UAE");
  const imageSlots = ["p14_ru_images_1", "p15_ru_images_2", "p16_ru_images_3", "p17_ru_images_4"];
  const ruImageChunks = chunk(ruImages, 6).slice(0, 4);
  const buildGrid = async (
    rows: RawInventoryItem[],
    assetRef: string,
    slotId: string,
    title: string
  ): Promise<boolean> => {
    if (rows.length === 0) return false;
    const png = await svgToPngBase64(
      buildImageGridSvg({
        title,
        items: rows.slice(0, 6).map((r) => {
          const hl = classifyObservationHighlight({
            url: r.sourceUrl ?? null,
            domain: domainOf(r.sourceUrl) || null,
            title: r.title ?? null,
            snippet: r.snippet ?? null,
          } as unknown as PersistedSerpObservation);
          return {
            title: String(r.title ?? "").slice(0, 80) || "Изображение из поиска",
            domain: domainOf(r.sourceUrl) || domainOf(r.imageUrl) || "источник в выдаче",
            unavailableNote: "Синтетическая карточка: превью из API недоступно офлайн",
            highlight: hl.isHighlighted,
            frameTone: hl.isHighlighted ? ("red" as const) : ("none" as const),
            themeLabel: hl.themeTitle ?? undefined,
          };
        }),
      })
    );
    const visibleItems = rows.slice(0, 6).map(toVisibleItem);
    const asset: RendererAssetEntry = {
      assetRef,
      kind: "image_grid",
      title,
      caption: "Изображения из поисковой выдачи по запросам о субъекте (метаданные API)",
      imageData: png,
      evidenceRefs: visibleItems.map((v) => v.ref),
    };
    push(asset);
    bind(slotId, meta(asset, visibleItems));
    return true;
  };
  for (let i = 0; i < ruImageChunks.length; i += 1) {
    if (
      await buildGrid(
        ruImageChunks[i],
        `ru_image_grid_${i + 1}`,
        imageSlots[i],
        `Россия — изображения в поиске (${i + 1})`
      )
    ) {
      counts.imageGrids += 1;
    }
  }
  if (await buildGrid(uaeImages, "uae_image_grid", "p30_uae_images", "ОАЭ — изображения в поиске")) {
    counts.imageGrids += 1;
  }

  return { assets, visualAssets, counts };
}
