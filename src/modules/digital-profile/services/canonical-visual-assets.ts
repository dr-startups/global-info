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
  NotShownRow,
  VisibleAssetItem,
  VisualAssetMeta,
  VisualAssetsBySlot,
} from "../orion-golden/deck-sections/canonical-slots";
import type { RendererAssetEntry } from "../orion-golden/deck-sections/run-deck-build";
import { renderSerpSnapshotPng } from "../serp-snapshot/renderer";
import { buildSyntheticSerpViewModelFromObservations } from "../serp-observation/synthetic-asset";
import { serpMaterialKey } from "../serp-observation/material-key";
import {
  filterObservationsForSyntheticSerp,
} from "../serp-observation/filter-synthetic-serp-noise";
import {
  selectVisibleObservationsForEngine,
} from "../serp-observation/synthetic-asset";
import {
  classifyObservationHighlight,
  type ObservationVerdictByRef,
} from "../serp-observation/resolve-observation-highlights";
import type { PersistedSerpObservation } from "../serp-observation/types";
import {
  buildImageGridSvg,
  buildKnowledgePanelSvg,
  buildSurfacePanelSvg,
  fetchImagePreviewsWithBudget,
  svgToPngBase64,
  type ImageGridItem,
  type ImagePreviewFetchOptions,
  type PreviewFailureReason,
} from "../orion-golden/assets/media-asset-svg";
import { mapSurfaceBucket } from "../orion-golden/classic/composite-serp-overlay-merge";
import { YANDEX_GEN_ANSWER_URL_SCHEME } from "../providers/yandex-gen-search";
import { plainAiAnswerText } from "../orion-golden/client/ai-answer-text";
import {
  pickRealSerpScreenshot,
  type RealSerpScreenshotInput,
} from "./evidence-supplement-adapter";

/** REMEDIATION §5.1 — one asset failure must not wipe the whole visual set. */
export type VisualAssetFailure = {
  kind: string;
  slotId: string;
  assetRef: string;
  reason: string;
};

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
    /** How many SERP slots used a real (LIVE/fixture) screenshot. */
    realSerpSnapshots: number;
  };
  /** Per-asset failures (F7); remaining assets stay built. */
  failed: VisualAssetFailure[];
};

/** Probe sharp once so a missing native binary surfaces as one clear error. */
export async function assertSharpAvailable(): Promise<void> {
  const tiny =
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="#fff"/></svg>';
  try {
    await svgToPngBase64(tiny);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SHARP_UNAVAILABLE: ${msg}`);
  }
}

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
  // `ARSENKIN` означает «поставщик известен, система — нет»: так помечены
  // только те инструменты, где систему не выбирают (аудит URL) или где один
  // запрос охватывает обе сразу (`check-top` с массивом `se`). Для них выдача
  // считается гугловой, иначе пустует слот органики по ОАЭ.
  //
  // Там, где система выбрана параметром `se`, она теперь и записывается —
  // см. `resolveObservationEngine`. Прежде это правило переписывало её здесь
  // задним числом, и подсказки Яндекса попадали на слайд Google под ярлыком
  // Google, а слайд «Россия — подсказки Яндекса» выходил пустым.
  if (/ARSENKIN/.test(raw)) return "GOOGLE";
  return null;
}

function surfaceOf(item: RawInventoryItem): string {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  return mapSurfaceBucket(String(meta.surface ?? item.evidenceType ?? "organic"));
}

function refOf(item: RawInventoryItem): string {
  return `inventory:${item.inventoryId}`;
}

/**
 * Первое наблюдение каждого материала, в порядке набора.
 *
 * Ключ общий с таблицей выдачи и с отбором строк для синтетического снимка:
 * ответ на вопрос «одна ли это строка» в продукте один. Строка, не называющая
 * материала, остаётся собой — иначе она пропала бы молча.
 */
function firstPerMaterial(items: RawInventoryItem[]): RawInventoryItem[] {
  const seen = new Set<string>();
  return items.filter((it) => {
    const key = serpMaterialKey({ url: it.sourceUrl, title: it.title }, refOf(it));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function toVisibleItem(
  item: RawInventoryItem,
  verdictByRef?: ObservationVerdictByRef
): VisibleAssetItem {
  const hl = classifyObservationHighlight(
    {
      url: item.sourceUrl ?? null,
      domain: domainOf(item.sourceUrl) || null,
      title: item.title ?? null,
      snippet: item.snippet ?? null,
    } as unknown as PersistedSerpObservation,
    verdictByRef?.[refOf(item)]
  );
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

/** Тег в правой колонке панели — согласован с ярлыком таблицы выдачи. */
export const OTHER_SUBJECT_PANEL_TAG = "о другом лице";

/**
 * Строка панели и её запись в артефакте — из одного решения.
 *
 * Строка о другом человеке печатается: панель воспроизводит то, что показывает
 * поисковик, и спрятать её значило бы нарисовать выдачу, которой нет. Но
 * рисуется она нейтральной и с тегом принадлежности вместо seed-запроса —
 * красная рамка на ней спорила бы с числом в заголовке страницы, которое эту
 * строку не считает. Признак негативной формулировки при этом сохраняется
 * записью: страница называет исключение словами.
 */
export function panelRowWithOwnership(input: {
  item: VisibleAssetItem;
  decision?: string;
  meta?: string;
}): { visible: VisibleAssetItem; svg: { label: string; meta?: string; adverse: boolean } } {
  const other = input.decision === "OTHER_SUBJECT";
  const visible: VisibleAssetItem = {
    ...input.item,
    ...(other ? { adverse: false, adverseWording: input.item.adverse === true } : {}),
    ...(input.decision ? { subjectDecision: input.decision } : {}),
  };
  return {
    visible,
    svg: {
      label: String(input.item.title ?? "").trim(),
      meta: other ? OTHER_SUBJECT_PANEL_TAG : input.meta,
      adverse: visible.adverse === true,
    },
  };
}

function meta(
  asset: RendererAssetEntry,
  visibleItems: VisibleAssetItem[],
  notShown: NotShownRow[] = []
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
    ...(notShown.length ? { notShown } : {}),
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
  /** Решения по прочитанным страницам: рамки и легенда следуют им. */
  verdictByRef?: ObservationVerdictByRef;
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
      ...selectVisibleObservationsForEngine(filtered, "YANDEX", undefined, input.verdictByRef),
      ...selectVisibleObservationsForEngine(filtered, "GOOGLE", undefined, input.verdictByRef),
    ].map((o) => o.id)
  );
  if (visibleIds.size === 0) return false;

  const vm = buildSyntheticSerpViewModelFromObservations({
    observations: allObs,
    subjectName: input.subjectName,
    queryText: dominantQuery(attributable, input.subjectName),
    language: input.region === "UAE" ? "en" : "ru",
    verdictByRef: input.verdictByRef,
  });
  const png = await renderSerpSnapshotPng(vm);

  const visibleItems = observations
    .filter((o) => visibleIds.has(o.obs.id))
    .map((o) => toVisibleItem(o.item, input.verdictByRef));
  const asset: RendererAssetEntry = {
    assetRef: input.assetRef,
    kind: "serp_screenshot",
    // Заголовок и подпись называют содержимое, а не способ его отрисовки:
    // в снимке настоящие строки выдачи, и «синтетический» рядом с ними клиент
    // читает как «выдумано». Источник данных остаётся в подвале самой картинки.
    title:
      input.region === "UAE"
        ? "ОАЭ — результаты поисковой выдачи"
        : "Россия — результаты поисковой выдачи",
    caption: "Результаты поисковой выдачи на момент сбора",
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
  /** Принадлежность строк субъекту: решения subject-resolution по ссылкам. */
  subjectDecisionByRef?: Record<string, string>;
  /** Решения по прочитанным страницам: рамка на панели следует им. */
  verdictByRef?: ObservationVerdictByRef;
  /** Test hook (§5.1): force this panel to throw. */
  injectFailureForAssetRef?: string;
}): Promise<boolean> {
  if (
    input.injectFailureForAssetRef &&
    input.injectFailureForAssetRef === input.assetRef
  ) {
    throw new Error(`injected-visual-failure:${input.assetRef}`);
  }
  const rows = input.rows.filter((r) => String(r.title ?? "").trim()).slice(0, 10);
  if (rows.length === 0) return false;
  // Нарисованная строка и её запись выводятся вместе: разойтись они не могут.
  const drawn = rows.map((r) =>
    panelRowWithOwnership({
      item: toVisibleItem(r, input.verdictByRef),
      decision: input.subjectDecisionByRef?.[refOf(r)],
      meta: input.rowMeta?.(r),
    })
  );
  const visibleItems = drawn.map((d) => d.visible);
  const png = await svgToPngBase64(
    buildSurfacePanelSvg({
      title: input.title,
      subtitle: input.subtitle,
      engineLabel: input.engineLabel,
      // Same red-frame classifier the SERP snapshot uses: negative phrases
      // are visibly marked on the panel itself (ORION style).
      items: drawn.map((d) => d.svg),
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
  /**
   * Разрешена ли сеть за превью изображений. По умолчанию — по окружению
   * (`NETWORK_CALLS`), и запретить оно может всегда. Выборку это не выключает:
   * кэш прогона читается в любом случае, а некэшированный адрес получает отказ
   * `offline` без запроса.
   */
  allowImagePreviewNetwork?: boolean;
  /**
   * REMEDIATION §5.2 — disk cache dir for URL→preview (job artifacts).
   * Resume/rebuild skips network when the URL is already cached.
   */
  previewCacheDir?: string;
  /** Test-only (§5.2): injected fetch / concurrency / budget overrides. */
  previewFetch?: ImagePreviewFetchOptions;
  /**
   * Fresh real SERP screenshots (§1.4). When present for a region, they replace
   * the synthetic snapshot for p10 (RU) / p27 (UAE).
   */
  realSerpScreenshots?: RealSerpScreenshotInput[];
  /**
   * Принадлежность строк субъекту: `evidenceRef → решение subject-resolution`.
   *
   * Без карты поведение построителя прежнее — вызов без аналитики остаётся
   * валидным. С картой строка о другом лице уходит на панель нейтральной.
   */
  subjectDecisionByRef?: Record<string, string>;
  /**
   * Решения по прочитанным страницам: `evidenceRef → тон, цитата, ярлык сюжета`.
   *
   * Без карты поведение прежнее — словарь заголовков. С картой красную рамку и
   * легенду снимка назначает прочитанная страница, а словарь остаётся только
   * для строк, которых не читали: два ответа на «негативна ли строка» на одном
   * листе противоречили друг другу.
   */
  verdictByRef?: ObservationVerdictByRef;
  /** Optional clock for freshness tests. */
  nowMs?: number;
  /** Test-only (§5.1): throw inside the builder for this assetRef. */
  injectFailureForAssetRef?: string;
}): Promise<CanonicalVisualAssets> {
  // One sharp probe up front — missing natives → single SHARP_UNAVAILABLE.
  await assertSharpAvailable();

  /*
   * Отказы превью считаются по причинам, а не тонут поштучно.
   *
   * Пустая плитка в отчёте говорит «источник не отдал изображение», и по ней
   * не отличить запрет площадки от нашей ошибки. В отчёте 72 три плитки из
   * шести были пустыми — Википедия, ТАСС, МГИМО, — и причина (запрос уходил
   * без `User-Agent`, а Викимедиа отвечает на такие 403) не была видна нигде.
   */
  const previewFailures = new Map<string, number>();
  const previewOpts: ImagePreviewFetchOptions = {
    concurrency: 4,
    timeoutMs: 5000,
    budgetMs: 30_000,
    ...input.previewFetch,
    cacheDir: input.previewFetch?.cacheDir ?? input.previewCacheDir,
    // Выборка не выключается: кэш — это уже купленные превью, и пересборка
    // оплаченного прогона обязана их получить. Выключается только сеть — и
    // тестовые опции перебивают выключатель лишь тогда, когда сказали об этом.
    allowNetwork: input.previewFetch?.allowNetwork ?? input.allowImagePreviewNetwork,
    onFailure: (_url, reason) => {
      previewFailures.set(reason, (previewFailures.get(reason) ?? 0) + 1);
      input.previewFetch?.onFailure?.(_url, reason);
    },
  };
  const assets: RendererAssetEntry[] = [];
  const visualAssets: VisualAssetsBySlot = {};
  const failed: VisualAssetFailure[] = [];
  const push = (a: RendererAssetEntry) => assets.push(a);
  const bind = (slotId: string, m: VisualAssetMeta) => {
    (visualAssets[slotId] ??= []).push(m);
  };
  const runAsset = async (
    kind: string,
    slotId: string,
    assetRef: string,
    fn: () => Promise<boolean>
  ): Promise<boolean> => {
    try {
      return await fn();
    } catch (err) {
      failed.push({
        kind,
        slotId,
        assetRef,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };

  const by = (pred: (it: RawInventoryItem) => boolean) => input.items.filter(pred);
  const counts = {
    serpSnapshots: 0,
    suggestionPanels: 0,
    relatedPanels: 0,
    aiPanels: 0,
    imageGrids: 0,
    realSerpSnapshots: 0,
  };

  // --- SERP snapshots: prefer real (§1.4), else synthetic -----------------
  for (const [region, assetRef, slotId] of [
    ["RU", "ru_serp_snapshot", "p10_ru_serp_visual"],
    ["UAE", "uae_serp_snapshot", "p27_uae_serp_visual"],
  ] as const) {
    const ok = await runAsset("serp_snapshot", slotId, assetRef, async () => {
      const real = pickRealSerpScreenshot(input.realSerpScreenshots ?? [], region, {
        nowMs: input.nowMs,
      });
      if (real) {
        const organic = by(
          (it) => surfaceOf(it) === "organic" && regionOf(it.region) === region
        );
        /*
         * Настоящий скриншот перечисляет материалы, а не наблюдения.
         *
         * Рамок мы на нём не рисуем, и `visibleItems` здесь — утверждение о
         * том, что читатель видит на снимке выдачи. Поисковик одну и ту же
         * страницу дважды не показывает, а в наборе она лежит отдельным
         * наблюдением на каждый запрос, которым найдена, — без сведения
         * страница печатала бы два дословно одинаковых объяснения под одним
         * результатом.
         */
        const visibleItems = firstPerMaterial(organic)
          .slice(0, 10)
          .map((it) => toVisibleItem(it, input.verdictByRef));
        const asset: RendererAssetEntry = {
          assetRef: `${assetRef}_real_${real.id}`,
          kind: "live_serp",
          title:
            real.title ??
            (region === "UAE"
              ? "ОАЭ — снимок выдачи (LIVE)"
              : "Россия — снимок выдачи (LIVE)"),
          caption:
            real.caption ??
            "Реальный снимок поисковой выдачи (существующий контур захвата).",
          imageData: real.imageData,
          evidenceRefs: [
            ...(real.evidenceRefs ?? [`serp_capture:${real.id}`]),
            ...visibleItems.map((v) => v.ref),
          ],
        };
        push(asset);
        bind(slotId, meta(asset, visibleItems));
        counts.realSerpSnapshots += 1;
        return true;
      }
      return buildSerpSnapshotAsset({
        assetRef,
        region,
        slotId,
        subjectName: input.subjectName,
        items: by((it) => surfaceOf(it) === "organic" && regionOf(it.region) === region),
        bind,
        push,
        verdictByRef: input.verdictByRef,
      });
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
    await runAsset("suggestion_panel", "p11_ru_suggestions_yandex", "ru_suggestions_yandex", () =>
      buildListPanelAsset({
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
        subjectDecisionByRef: input.subjectDecisionByRef,
        verdictByRef: input.verdictByRef,
        injectFailureForAssetRef: input.injectFailureForAssetRef,
      })
    )
  ) {
    counts.suggestionPanels += 1;
  }
  const p12Rows =
    ruGoogle.length > 0 ? ruGoogle : ruYandex.length > 0 ? ruUnattributed : [];
  if (
    await runAsset("suggestion_panel", "p12_ru_suggestions_google", "ru_suggestions_google", () =>
      buildListPanelAsset({
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
        subjectDecisionByRef: input.subjectDecisionByRef,
        verdictByRef: input.verdictByRef,
        injectFailureForAssetRef: input.injectFailureForAssetRef,
      })
    )
  ) {
    counts.suggestionPanels += 1;
  }
  if (
    await runAsset("suggestion_panel", "p28_uae_suggestions", "uae_suggestions", () =>
      buildListPanelAsset({
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
        subjectDecisionByRef: input.subjectDecisionByRef,
        verdictByRef: input.verdictByRef,
        injectFailureForAssetRef: input.injectFailureForAssetRef,
      })
    )
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
    const assetRef = `ru_related_${i + 1}`;
    if (
      await runAsset("related_panel", relatedSlots[i], assetRef, () =>
        buildListPanelAsset({
          assetRef,
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
          subjectDecisionByRef: input.subjectDecisionByRef,
          verdictByRef: input.verdictByRef,
          injectFailureForAssetRef: input.injectFailureForAssetRef,
        })
      )
    ) {
      counts.relatedPanels += 1;
    }
  }
  if (
    await runAsset("related_panel", "p32_uae_related", "uae_related", () =>
      buildListPanelAsset({
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
        subjectDecisionByRef: input.subjectDecisionByRef,
        verdictByRef: input.verdictByRef,
        injectFailureForAssetRef: input.injectFailureForAssetRef,
      })
    )
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
    // Сводкой панели становится тело ответа: у названного источника есть свой
    // адрес, и его описание — не ответ поисковика. Панель рисует абзац с
    // переносом по словам; полный ответ по-прежнему несёт текст страницы.
    const answer =
      rows.find(
        (r) =>
          String(r.sourceUrl ?? "").startsWith(YANDEX_GEN_ANSWER_URL_SCHEME) &&
          String(r.snippet ?? "").trim()
      ) ?? rows.find((r) => String(r.snippet ?? "").trim());
    if (!answer && rows.length === 0) return false;
    const facts = rows
      .filter((r) => r !== answer)
      .slice(0, 4)
      .map((r) => String(r.title ?? r.sourceUrl ?? "").trim())
      .filter(Boolean);
    const png = await svgToPngBase64(
      buildKnowledgePanelSvg({
        title,
        // Та же чистка, что у текста страницы: панель и страница не могут
        // показывать один ответ по-разному.
        summary:
          plainAiAnswerText(answer?.snippet) ||
          String(answer?.title ?? "Ответ ИИ-поиска зафиксирован без развёрнутого текста"),
        facts,
      })
    );
    const used = [answer, ...rows.filter((r) => r !== answer).slice(0, 4)].filter(
      (r): r is RawInventoryItem => Boolean(r)
    );
    const visibleItems = used.map((it) => toVisibleItem(it, input.verdictByRef));
    const asset: RendererAssetEntry = {
      assetRef,
      kind: "knowledge_panel",
      title,
      caption: "Ответ ИИ-поиска по запросам о субъекте",
      imageData: png,
      evidenceRefs: visibleItems.map((v) => v.ref),
    };
    push(asset);
    bind(slotId, meta(asset, visibleItems));
    return true;
  };

  if (ruAi.length > 0) {
    if (
      await runAsset("ai_panel", "p19_ru_knowledge_2", "ru_ai_answers", () =>
        buildAiPanel(ruAi, "ru_ai_answers", "p19_ru_knowledge_2", "Россия — ИИ-ответы поисковых систем")
      )
    ) {
      counts.aiPanels += 1;
    }
  }
  const ruKnowledge = ruAi.filter((it) => surfaceOf(it) === "knowledge_block");
  // Knowledge Graph is often absent for persons; fall back to Wikipedia / AI panel
  // so p18 still gets a client-facing visual when RU evidence exists.
  const ruKnowledgeFallback =
    ruKnowledge.length > 0
      ? ruKnowledge
      : by((it) => surfaceOf(it) === "wikipedia" && regionOf(it.region) === "RU").length > 0
        ? by((it) => surfaceOf(it) === "wikipedia" && regionOf(it.region) === "RU")
        : ruAi;
  if (ruKnowledgeFallback.length > 0) {
    if (
      await runAsset("ai_panel", "p18_ru_knowledge_1", "ru_knowledge_panel", () =>
        buildAiPanel(
          ruKnowledgeFallback,
          "ru_knowledge_panel",
          "p18_ru_knowledge_1",
          "Россия — панель знаний поиска"
        )
      )
    ) {
      counts.aiPanels += 1;
    }
  }
  if (uaeAi.length > 0) {
    if (
      await runAsset("ai_panel", "p31_uae_knowledge", "uae_ai_answers", () =>
        buildAiPanel(uaeAi, "uae_ai_answers", "p31_uae_knowledge", "ОАЭ — панель знаний и AI Overview")
      )
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
  /**
   * Первое разрешившееся RU-превью уходит на обложку (`cover_portrait`) —
   * квадрат со скруглёнными углами справа от имени субъекта. Своего поиска
   * ради обложки не делается: берётся уже собранное превью, и если его нет,
   * обложка рисует абстрактную графику бренда, а не пустую рамку.
   */
  let coverPortraitPushed = false;
  const buildGrid = async (
    rows: RawInventoryItem[],
    assetRef: string,
    slotId: string,
    title: string
  ): Promise<boolean> => {
    if (rows.length === 0) return false;
    const slice = rows.slice(0, 6);
    const urlOf = (r: RawInventoryItem) => r.imageUrl || r.sourceUrl;
    /*
     * Причина отказа — по адресу, а не только счётчиком прогона.
     *
     * Строка без превью на сетку не попадает, и страница обязана сказать, что
     * именно осталось за кадром и почему: `offline` («мы не спрашивали») и
     * `http_403` («площадка отказала») — разные новости для читателя.
     */
    const reasonByUrl = new Map<string, PreviewFailureReason>();
    const previews = await fetchImagePreviewsWithBudget(slice.map(urlOf), {
      ...previewOpts,
      onFailure: (url, reason) => {
        reasonByUrl.set(url, reason);
        previewOpts.onFailure?.(url, reason);
      },
    });
    const drawnItems: Array<{ row: RawInventoryItem; item: ImageGridItem }> = [];
    const notShown: NotShownRow[] = [];
    for (const r of slice) {
      const hl = classifyObservationHighlight({
        url: r.sourceUrl ?? null,
        domain: domainOf(r.sourceUrl) || null,
        title: r.title ?? null,
        snippet: r.snippet ?? null,
      } as unknown as PersistedSerpObservation);
      const url = urlOf(r);
      const previewBase64 = url ? previews.get(url) : undefined;
      if (!previewBase64) {
        notShown.push({
          ref: refOf(r),
          adverse: hl.isHighlighted,
          reason: (url ? reasonByUrl.get(url) : undefined) ?? "no_url",
        });
        continue;
      }
      drawnItems.push({
        row: r,
        item: {
          title: String(r.title ?? "").slice(0, 80) || "Изображение из поиска",
          domain: domainOf(r.sourceUrl) || domainOf(r.imageUrl) || "источник в выдаче",
          previewBase64,
          highlight: hl.isHighlighted,
          frameTone: hl.isHighlighted ? ("red" as const) : ("none" as const),
          themeLabel: hl.themeTitle ?? undefined,
        },
      });
    }
    // Одна выборка кормит и краску, и счёт: `visibleItems` — ровно те строки,
    // что попали в PNG, поэтому счётные строки страницы считают нарисованное.
    const visibleItems = drawnItems.map((d) => toVisibleItem(d.row, input.verdictByRef));
    if (drawnItems.length === 0) {
      // Рисовать нечего — ассета нет, страница уходит в текстовую ветку. Мета
      // без картинки нужна ей, чтобы назвать словами, что найдено и не показано.
      bind(slotId, {
        assetRef,
        kind: "image_grid",
        title,
        hasImage: false,
        visibleItems: [],
        ...(notShown.length ? { notShown } : {}),
      });
      /*
       * Пропавшая поверхность слышна там же, где остальные потери ассетов.
       *
       * Одной строки в консоли мало: оператор судит о прогоне по
       * `report-quality-summary`, и целая страница изображений, не доехавшая до
       * документа, обязана быть в нём названа.
       */
      failed.push({
        kind: "image_grid",
        slotId,
        assetRef,
        reason: `превью не получено ни для одной из ${notShown.length} строк (${[
          ...new Set(notShown.map((n) => n.reason)),
        ].join(", ")})`,
      });
      return false;
    }
    const png = await svgToPngBase64(
      buildImageGridSvg({ title, items: drawnItems.map((d) => d.item) })
    );
    if (!coverPortraitPushed) {
      push({
        assetRef: "cover_portrait",
        kind: "cover_portrait",
        title: "Портрет субъекта",
        caption: "Фото из поисковой выдачи",
        imageData: drawnItems[0]!.item.previewBase64,
        evidenceRefs: [visibleItems[0]!.ref],
      });
      coverPortraitPushed = true;
    }
    const asset: RendererAssetEntry = {
      assetRef,
      kind: "image_grid",
      title,
      caption: "Изображения из поисковой выдачи по запросам о субъекте (метаданные API)",
      imageData: png,
      evidenceRefs: visibleItems.map((v) => v.ref),
    };
    push(asset);
    bind(slotId, meta(asset, visibleItems, notShown));
    return true;
  };
  for (let i = 0; i < ruImageChunks.length; i += 1) {
    const assetRef = `ru_image_grid_${i + 1}`;
    if (
      await runAsset("image_grid", imageSlots[i], assetRef, () =>
        buildGrid(
          ruImageChunks[i],
          assetRef,
          imageSlots[i],
          `Россия — изображения в поиске (${i + 1})`
        )
      )
    ) {
      counts.imageGrids += 1;
    }
  }
  if (
    await runAsset("image_grid", "p30_uae_images", "uae_image_grid", () =>
      buildGrid(uaeImages, "uae_image_grid", "p30_uae_images", "ОАЭ — изображения в поиске")
    )
  ) {
    counts.imageGrids += 1;
  }

  // Строка о превью — рядом со строкой о чтении ссылок: обе отвечают на вопрос
  // «чего в отчёте нет и почему».
  if (previewFailures.size > 0) {
    const parts = [...previewFailures.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason}: ${n}`);
    console.log(`[digital-profile][превью] не получено изображений — ${parts.join(", ")}`);
  }

  return { assets, visualAssets, counts, failed };
}
