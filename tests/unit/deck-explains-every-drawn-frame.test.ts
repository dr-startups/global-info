/**
 * Дека объясняет то, что нарисовано, и не пересчитывает картинку.
 *
 * Рамку рисует не дека: снимок выдачи и панели впечатывают её в PNG, сетка
 * изображений — в плитку. `visibleItems` привязанного ассета и есть ответ на
 * вопрос «сколько рамок на этом листе», поэтому объяснений столько же, сколько
 * выделенных строк нарисовано.
 *
 * Сводить строки по материалу обязан тот, кто их выбирает для показа: у него
 * известна единица рисования (колонка движка у снимка, плитка у сетки). Пока
 * сведение стояло в общем разборе деки, оно склеивало то, что нарисовано
 * порознь: строку Яндекса со строкой Google на одном снимке и две плитки одной
 * статьи на сетке — и лист выходил с двумя красными рамками при подписи
 * «выделено красным: 1».
 */

import { describe, expect, it, vi } from "vitest";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import { svgToPngBase64 } from "@/modules/digital-profile/orion-golden/assets/media-asset-svg";
import { loadReport72DeckInputs } from "../../scripts/run-orion-deck-sections-report72";
import { buildSectionPackForFragment } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import type { SectionBuildContext } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import { adverseVisualSidebar } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ExecutiveSummaryExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type {
  VisibleAssetItem,
  VisualAssetsBySlot,
} from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import type {
  ScopedEvidenceIndex,
  ScopedFragmentInput,
} from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const inputs = loadReport72DeckInputs();
const SNAPSHOT_SLOT = "p10_ru_serp_visual";
const GRID_SLOT = "p14_ru_images_1";

/** Настоящий PNG: подделка отличалась бы от отказа площадки только случайно. */
const TILE_PNG = await svgToPngBase64(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#3355aa"/></svg>'
);

function imageResponse(base64: string): Response {
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/png" : null) },
    arrayBuffer: async () => bytes.buffer,
  } as unknown as Response;
}

/** Строка органики: движок задаётся явно — снимок рисует две колонки. */
function organicRow(input: {
  id: string;
  url: string;
  title: string;
  engine: "YANDEX" | "GOOGLE";
}): RawInventoryItem {
  return {
    inventoryId: input.id,
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serper",
    provider: "serper",
    region: "RU",
    query: "Сергей Глинка",
    collectedAt: "2026-01-15T12:00:00.000Z",
    evidenceType: "organic_result",
    title: input.title,
    snippet: null,
    sourceUrl: input.url,
    rawMetadata: { surface: "organic", engine: input.engine },
  } as unknown as RawInventoryItem;
}

/** Строка выдачи по картинкам: у двух плиток бывает одна страница-источник. */
function imageRow(input: {
  id: string;
  sourceUrl: string;
  imageUrl: string;
  title: string;
}): RawInventoryItem {
  return {
    inventoryId: input.id,
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serper",
    provider: "serper",
    region: "RU",
    query: "Сергей Глинка",
    collectedAt: "2026-01-15T12:00:00.000Z",
    evidenceType: "image_result",
    title: input.title,
    snippet: null,
    sourceUrl: input.sourceUrl,
    imageUrl: input.imageUrl,
    rawMetadata: { surface: "images", engine: "YANDEX" },
  } as unknown as RawInventoryItem;
}

async function buildAssets(rows: RawInventoryItem[]): Promise<VisualAssetsBySlot> {
  const fetchImpl = vi.fn(async () => imageResponse(TILE_PNG));
  const visuals = await buildCanonicalVisualAssets({
    subjectName: "Сергей Глинка",
    items: rows,
    previewFetch: { fetchImpl: fetchImpl as unknown as typeof fetch, allowNetwork: true },
  });
  return visuals.visualAssets;
}

/** Разбор боковой панели поверх настоящих метаданных ассета. */
function sidebarFor(slotId: string, visualAssets: VisualAssetsBySlot) {
  const scoped = { evidenceIndex: {}, findings: [] } as unknown as ScopedFragmentInput;
  return adverseVisualSidebar(slotId, { visualAssets } as unknown as FragmentExtras, scoped);
}

function drawnRows(slotId: string, visualAssets: VisualAssetsBySlot): VisibleAssetItem[] {
  return (visualAssets[slotId] ?? []).flatMap((a) => a.visibleItems ?? []);
}

/** Снимок выдачи, собранный настоящим построителем секции. */
function snapshotSlide(rows: VisibleAssetItem[], evidenceIndex: ScopedEvidenceIndex) {
  const visualAssets: VisualAssetsBySlot = {
    [SNAPSHOT_SLOT]: [
      {
        assetRef: "ru_serp_snapshot",
        kind: "serp_screenshot",
        title: "Россия — результаты поисковой выдачи",
        hasImage: true,
        evidenceRefs: rows.map((r) => r.ref),
        visibleItems: rows,
      },
    ],
  };
  const ctx: SectionBuildContext = {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    contentVersion: "test-content-version",
    subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
    bundle: inputs.mergedBundle,
    surfaceUnits: inputs.surfaceUnits,
    metricSnapshot: inputs.metricSnapshot,
    evidenceIndex,
    extras: {
      executiveSummary: inputs.executiveSummary as unknown as ExecutiveSummaryExtras,
      surfaceCollectionHints: inputs.surfaceCollectionHints,
      visualAssets,
    },
    buildLog: [],
  };
  const base = buildSectionPackForFragment("RU_SERP_SCREENSHOT", ctx).slides.find(
    (s) => !s.isContinuation
  )!;
  return {
    explanations: base.content.highlightExplanations ?? [],
    whatWasFound: String(base.content.whatWasFound ?? ""),
    adverseHighlights: Number(base.metrics?.adverseHighlights ?? -1),
  };
}

const RUCRIMINAL = "https://rucriminal.info/dosje/125";

describe("одна нарисованная рамка — одно объяснение", () => {
  it("один материал в колонке Яндекса и в колонке Google — две рамки и два объяснения", async () => {
    const visualAssets = await buildAssets([
      organicRow({ id: "ya-1", url: RUCRIMINAL, title: "Досье: компромат", engine: "YANDEX" }),
      organicRow({ id: "go-1", url: RUCRIMINAL, title: "Досье: компромат", engine: "GOOGLE" }),
      organicRow({
        id: "ya-2",
        url: "https://rupep.org/ru/person/8095",
        title: "PEP: Глинка",
        engine: "YANDEX",
      }),
    ]);
    const rows = drawnRows(SNAPSHOT_SLOT, visualAssets);
    const framed = rows.filter((r) => r.adverse);
    // Страница, найденная обоими поисковиками, стоит в обеих колонках: снимок
    // показывает выдачу, а не список материалов.
    expect(framed).toHaveLength(3);
    expect(sidebarFor(SNAPSHOT_SLOT, visualAssets).explanations).toHaveLength(3);
  });

  it("две плитки одной статьи — две рамки и два объяснения", async () => {
    const visualAssets = await buildAssets([
      imageRow({
        id: "img-1",
        sourceUrl: "https://rucriminal.info/dosje/125",
        imageUrl: "https://cdn.rucriminal.info/a.jpg",
        title: "Досье: компромат",
      }),
      imageRow({
        id: "img-2",
        sourceUrl: "https://rucriminal.info/dosje/125",
        imageUrl: "https://cdn.rucriminal.info/b.jpg",
        title: "Досье: компромат",
      }),
      imageRow({
        id: "img-3",
        sourceUrl: "https://kapitalnytt.se/event",
        imageUrl: "https://cdn.kapitalnytt.se/c.jpg",
        title: "Деловое мероприятие",
      }),
    ]);
    const rows = drawnRows(GRID_SLOT, visualAssets);
    const framed = rows.filter((r) => r.adverse);
    expect(rows).toHaveLength(3);
    expect(framed).toHaveLength(2);
    expect(sidebarFor(GRID_SLOT, visualAssets).adverseRows).toHaveLength(2);
    expect(sidebarFor(GRID_SLOT, visualAssets).explanations).toHaveLength(2);
  });

  it("одна и та же строка, попавшая в видимые дважды, — одна рамка", () => {
    const row: VisibleAssetItem = {
      ref: "inventory:one",
      url: RUCRIMINAL,
      domain: "rucriminal.info",
      title: "Досье",
      engine: "GOOGLE",
      region: "RU",
      adverse: true,
    };
    const visualAssets: VisualAssetsBySlot = {
      [SNAPSHOT_SLOT]: [
        {
          assetRef: "ru_serp_snapshot",
          kind: "serp_screenshot",
          title: "Снимок",
          hasImage: true,
          visibleItems: [row, row],
        },
      ],
    };
    const sidebar = sidebarFor(SNAPSHOT_SLOT, visualAssets);
    expect(sidebar.visibleRows).toHaveLength(2);
    expect(sidebar.explanations).toHaveLength(1);
    // Счёт выделенного и число объяснений — одна величина: по `adverseRows`
    // страница изображений печатает «выделено красным: N».
    expect(sidebar.adverseRows).toHaveLength(1);
  });
});

describe("подпись снимка называет число объяснений", () => {
  const evidence = (refs: string[]): ScopedEvidenceIndex => {
    const index: ScopedEvidenceIndex = { ...inputs.evidenceIndex };
    for (const [i, ref] of refs.entries()) {
      index[ref] = {
        url: `https://rucriminal.info/dosje/${i}`,
        domain: "rucriminal.info",
        title: `Досье ${i}`,
        provider: "arsenkin",
        kind: "organic",
        region: "RU",
        engine: "GOOGLE",
      } as ScopedEvidenceIndex[string];
    }
    return index;
  };

  it("подпись, метрика и объяснения — одно число", () => {
    const refs = ["inventory:a", "inventory:b", "inventory:c"];
    const rows: VisibleAssetItem[] = refs.map((ref, i) => ({
      ref,
      url: `https://rucriminal.info/dosje/${i}`,
      domain: "rucriminal.info",
      title: `Досье ${i}`,
      engine: "GOOGLE",
      region: "RU",
      adverse: true,
    }));
    const slide = snapshotSlide(rows, evidence(refs));
    expect(slide.explanations).toHaveLength(3);
    expect(slide.adverseHighlights).toBe(3);
    expect(slide.whatWasFound).toContain("На снимке выделено результатов повышенного внимания: 3");
  });
});
