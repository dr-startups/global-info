/**
 * Сетка изображений рисует только полученные превью.
 *
 * На живом прогоне в PDF было тридцать плиток при шестнадцати полученных
 * превью: не меньше четырнадцати серых прямоугольников «Превью недоступно:
 * источник не отдал изображение», и каждая страница при этом говорила
 * «Показано 6». Плитку-заглушку убрали решением владельца, а счёт пошёл по
 * нарисованному: `visibleItems` — ровно те строки, что попали в PNG.
 *
 * Кэш превью при этом не сеть: он читается и при `NETWORK_CALLS=0`, и при
 * запрещённой сети — пересборка оплаченного прогона обязана получить свои
 * купленные картинки. А вот разрешение сети окружением не перебивается: без
 * этого офлайн-контур перестаёт быть офлайн-контуром.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import {
  buildImageGridSvg,
  previewCachePath,
  svgToPngBase64,
  type ImageGridItem,
} from "@/modules/digital-profile/orion-golden/assets/media-asset-svg";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

/** Настоящий PNG: отказ sharp на подделке был бы неотличим от отказа площадки. */
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

function deniedResponse(): Response {
  return {
    ok: false,
    status: 403,
    headers: { get: () => null },
    arrayBuffer: async () => new Uint8Array().buffer,
  } as unknown as Response;
}

/** Строка выдачи по картинкам: свой домен у страницы и у самой картинки. */
function imageRow(i: number, opts?: { adverse?: boolean; imageUrl?: string }): RawInventoryItem {
  return {
    inventoryId: `img-${i}`,
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serper",
    provider: "serper",
    region: "RU",
    query: "Anders Holmström",
    collectedAt: "2026-01-15T12:00:00.000Z",
    evidenceType: "image_result",
    title: opts?.adverse
      ? `Anders Holmström fraud probe — photo ${i}`
      : `Anders Holmström at Nordkap Capital event ${i}`,
    snippet: `Image result ${i}.`,
    sourceUrl: `https://bildarkiv-${i}.se/page-${i}`,
    imageUrl: opts?.imageUrl ?? `https://cdn.bildarkiv-${i}.se/img-${i}.jpg`,
    rawMetadata: { surface: "images", engine: "YANDEX" },
  };
}

/** Сетка RU №1 (p14) из шести строк; превью отдаются только для `withPreview`. */
async function buildRuGrid(input: {
  rows: RawInventoryItem[];
  withPreview: Set<number>;
  allowImagePreviewNetwork?: boolean;
  previewCacheDir?: string;
  previewFetch?: Record<string, unknown>;
}) {
  const fetchImpl = vi.fn(async (url: string) => {
    const idx = input.rows.findIndex((r) => r.imageUrl === String(url));
    return input.withPreview.has(idx) ? imageResponse(TILE_PNG) : deniedResponse();
  });
  const visuals = await buildCanonicalVisualAssets({
    subjectName: "Anders Holmström",
    items: input.rows,
    ...(input.allowImagePreviewNetwork === undefined
      ? {}
      : { allowImagePreviewNetwork: input.allowImagePreviewNetwork }),
    ...(input.previewCacheDir ? { previewCacheDir: input.previewCacheDir } : {}),
    previewFetch: {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      ...(input.previewFetch ?? {}),
    },
  });
  return { visuals, fetchImpl };
}

describe("плитка без превью не рисуется", () => {
  it("шесть строк, три превью — три плитки и три строки в visibleItems", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => imageRow(i));
    const { visuals } = await buildRuGrid({ rows, withPreview: new Set([0, 1, 2]) });

    const meta = visuals.visualAssets.p14_ru_images_1?.[0];
    expect(meta?.visibleItems?.map((v) => v.ref)).toEqual([
      "inventory:img-0",
      "inventory:img-1",
      "inventory:img-2",
    ]);
    const grid = visuals.assets.find((a) => a.assetRef === "ru_image_grid_1");
    expect(grid?.evidenceRefs).toEqual(["inventory:img-0", "inventory:img-1", "inventory:img-2"]);
    expect(visuals.counts.imageGrids).toBe(1);
  });

  it("серый прямоугольник заглушки не рисуется ни при каком входе", () => {
    const svg = buildImageGridSvg({
      title: "Россия — изображения (1)",
      items: [
        { title: "Есть превью", domain: "bildarkiv-0.se", previewBase64: TILE_PNG },
        // Строка без превью на сетку не попадает вовсе; если она всё же придёт,
        // рисовать вместо неё серый прямоугольник с подписью нельзя.
        { title: "Нет превью", domain: "bildarkiv-1.se" } as unknown as ImageGridItem,
      ],
    });
    expect(svg.match(/<image /gu) ?? []).toHaveLength(1);
    expect(svg).not.toMatch(/fill="#f8fafc"/u);
    expect(svg).not.toMatch(/недоступно/iu);
  });

  it("содержимое кэша не вырывается из разметки", () => {
    const svg = buildImageGridSvg({
      title: "Россия — изображения (1)",
      items: [{ title: "Порча кэша", domain: "bildarkiv-0.se", previewBase64: 'AAA" onload="x' }],
    });
    expect(svg).toContain("&quot;");
    expect(svg).not.toContain('onload="x"');
  });
});

describe("ни одного превью — ни одной сетки", () => {
  it("ассет не создаётся, а слот получает мету без картинки и с причиной", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => imageRow(i));
    const { visuals } = await buildRuGrid({ rows, withPreview: new Set() });

    expect(visuals.assets.find((a) => a.assetRef === "ru_image_grid_1")).toBeUndefined();
    expect(visuals.counts.imageGrids).toBe(0);
    const meta = visuals.visualAssets.p14_ru_images_1?.[0];
    expect(meta?.hasImage).toBe(false);
    expect(meta?.visibleItems ?? []).toHaveLength(0);
    expect(meta?.notShown).toHaveLength(6);
    expect(meta?.notShown?.every((r) => r.reason === "http_403")).toBe(true);
  });

  it("потеря целой сетки слышна в сводке качества, а не только в консоли", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => imageRow(i));
    const { visuals } = await buildRuGrid({ rows, withPreview: new Set() });

    const failure = visuals.failed.find((f) => f.slotId === "p14_ru_images_1");
    expect(failure?.kind).toBe("image_grid");
    expect(failure?.reason ?? "").toMatch(/превью/iu);
  });
});

describe("не показанное названо с причиной и негативом", () => {
  it("мета несёт ссылку, причину и негативный признак по каждой строке", async () => {
    const rows = [
      imageRow(0),
      imageRow(1),
      imageRow(2),
      imageRow(3),
      imageRow(4),
      imageRow(5, { adverse: true }),
    ];
    const { visuals } = await buildRuGrid({ rows, withPreview: new Set([0, 1, 2]) });

    expect(visuals.visualAssets.p14_ru_images_1?.[0]?.notShown).toEqual([
      { ref: "inventory:img-3", adverse: false, reason: "http_403" },
      { ref: "inventory:img-4", adverse: false, reason: "http_403" },
      { ref: "inventory:img-5", adverse: true, reason: "http_403" },
    ]);
  });

  it("адрес, о котором не спрашивали, не выдаётся за отказ площадки", async () => {
    const rows = [
      imageRow(0, { imageUrl: "arsenkin://images/0" }),
      imageRow(1),
    ];
    rows[0]!.sourceUrl = undefined;
    const { visuals } = await buildRuGrid({ rows, withPreview: new Set([1]) });

    expect(visuals.visualAssets.p14_ru_images_1?.[0]?.notShown).toEqual([
      { ref: "inventory:img-0", adverse: false, reason: "no_url" },
    ]);
  });

  it("исчерпанный бюджет выборки называется бюджетом, а не отказом источника", async () => {
    const rows = Array.from({ length: 2 }, (_, i) => imageRow(i));
    const { visuals } = await buildRuGrid({
      rows,
      withPreview: new Set([0, 1]),
      previewFetch: { budgetMs: 0 },
    });

    expect(visuals.visualAssets.p14_ru_images_1?.[0]?.notShown?.map((r) => r.reason)).toEqual([
      "budget_exhausted",
      "budget_exhausted",
    ]);
  });
});

describe("кэш превью — не сеть", () => {
  it("при NETWORK_CALLS=0 плитка берётся из кэша без единого запроса", async () => {
    const dir = mkdtempSync(join(tmpdir(), "preview-cache-"));
    try {
      const rows = [imageRow(0)];
      mkdirSync(dir, { recursive: true });
      writeFileSync(previewCachePath(dir, rows[0]!.imageUrl!), TILE_PNG, "utf8");
      expect(process.env.NETWORK_CALLS).toBe("0");

      const { visuals, fetchImpl } = await buildRuGrid({
        rows,
        withPreview: new Set([0]),
        previewCacheDir: dir,
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      const meta = visuals.visualAssets.p14_ru_images_1?.[0];
      expect(meta?.hasImage).toBe(true);
      expect(meta?.visibleItems).toHaveLength(1);
      expect(meta?.notShown).toBeUndefined();
      // Байты обложки — ровно те, что лежали в кэше: доказательство, что кэш
      // прочитан, а не что плитка нарисовалась заглушкой.
      expect(visuals.assets.find((a) => a.assetRef === "cover_portrait")?.imageData).toBe(TILE_PNG);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("явный запрет сети не ходит в сеть даже при живом окружении", async () => {
    const prev = process.env.NETWORK_CALLS;
    process.env.NETWORK_CALLS = "1";
    try {
      const rows = Array.from({ length: 2 }, (_, i) => imageRow(i));
      const { visuals, fetchImpl } = await buildRuGrid({
        rows,
        withPreview: new Set([0, 1]),
        allowImagePreviewNetwork: false,
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      const meta = visuals.visualAssets.p14_ru_images_1?.[0];
      expect(meta?.notShown?.map((r) => r.reason)).toEqual(["offline", "offline"]);
    } finally {
      if (prev === undefined) delete process.env.NETWORK_CALLS;
      else process.env.NETWORK_CALLS = prev;
    }
  });

  it("тестовые опции выборки не перебивают запрет молча", async () => {
    const prev = process.env.NETWORK_CALLS;
    process.env.NETWORK_CALLS = "1";
    try {
      const rows = [imageRow(0)];
      // `previewFetch` без разрешения не должен затирать выключатель вызывающего.
      const { fetchImpl } = await buildRuGrid({
        rows,
        withPreview: new Set([0]),
        allowImagePreviewNetwork: false,
        previewFetch: { allowNetwork: undefined },
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.NETWORK_CALLS;
      else process.env.NETWORK_CALLS = prev;
    }
  });
});

describe("обложка берёт портрет из нарисованного", () => {
  it("портрет — первая строка с превью, а не первая строка набора", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => imageRow(i));
    const { visuals } = await buildRuGrid({ rows, withPreview: new Set([3, 4, 5]) });

    const portrait = visuals.assets.find((a) => a.assetRef === "cover_portrait");
    expect(portrait?.evidenceRefs).toEqual(["inventory:img-3"]);
    expect(portrait?.imageData).toBeTruthy();
  });
});
