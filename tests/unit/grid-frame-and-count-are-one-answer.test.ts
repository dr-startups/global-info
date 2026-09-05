/**
 * Плитка сетки и её запись — из одного решения.
 *
 * Отчёт 86: заголовок листа «1 изображение ведёт на негативный источник» и
 * сайдбар считали по маске признаков субъекта, а рамки на картинке рисовались
 * прежним словарём — из шести плиток красных было пять. На соседнем листе
 * «негативных источников нет» стояло над обведённой плиткой. Причина одна:
 * строка классифицировалась дважды, и второй ответ не знал о признаках.
 *
 * Портрет обложки читал тот же немаскированный ответ, поэтому подтверждённые
 * фотографии судьи (Право.ру, «Судьи России») считались негативными, и обложка
 * осталась без портрета вовсе.
 */

import { describe, expect, it, vi } from "vitest";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import { svgToPngBase64 } from "@/modules/digital-profile/orion-golden/assets/media-asset-svg";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { SubjectAnchors } from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";

const TILE_PNG = await svgToPngBase64(
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#3355aa"/></svg>'
);

const ANCHORS: SubjectAnchors = {
  birthDate: "1977-11-30",
  phrases: [
    { kind: "employer", text: "Арбитражный Суд Краснодарского края", strong: true },
    { kind: "position", text: "председатель Арбитражного суда Краснодарского края", strong: true },
  ],
  inn: [],
  domains: [],
};

function imageRow(i: number, title: string, withPreview: boolean): RawInventoryItem {
  return {
    inventoryId: `img-${i}`,
    caseId: "case-egorov",
    reportRunId: "run-1",
    source: "serper",
    provider: "serper",
    region: "RU",
    query: "Егоров Алексей Евгеньевич",
    collectedAt: "2026-09-05T12:00:00.000Z",
    evidenceType: "image_result",
    title,
    snippet: title,
    sourceUrl: `https://site-${i}.ru/page-${i}`,
    ...(withPreview ? { imageUrl: `https://cdn.site-${i}.ru/img-${i}.jpg` } : {}),
    rawMetadata: { surface: "images", engine: "GOOGLE" },
  } as RawInventoryItem;
}

/** Фотография судьи на портале о судьях — подтверждена, слова только служебные. */
const JUDGE_PHOTO = imageRow(0, "Судья Егоров Алексей Евгеньевич на портале Право.ру", true);
/** Такая же строка, но без превью: её оценка видна в `notShown`. */
const JUDGE_NO_PREVIEW = imageRow(1, "Егоров А.Е. | Арбитражный суд Краснодарского края", false);
/** Настоящий негатив: слово не из признаков субъекта. */
const CORRUPTION = imageRow(2, "Проверят председателя суда на коррупционность", true);

async function build(anchors: SubjectAnchors | null) {
  // Площадка второй строки превью не отдаёт: её оценка видна только в
  // `notShown`, а это тот же ответ, каким красится плитка.
  const fetchImpl = vi.fn(async (url: string) =>
    String(url).includes("site-1")
      ? { ok: false, status: 403, headers: { get: () => null }, arrayBuffer: async () => new Uint8Array().buffer }
      : {
          ok: true,
          status: 200,
          headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "image/png" : null) },
          arrayBuffer: async () => new Uint8Array(Buffer.from(TILE_PNG, "base64")).buffer,
        }
  ) as unknown as typeof fetch;
  return buildCanonicalVisualAssets({
    subjectName: "Егоров Алексей Евгеньевич",
    items: [JUDGE_PHOTO, JUDGE_NO_PREVIEW, CORRUPTION],
    subjectDecisionByRef: {
      "inventory:img-0": "SUBJECT_MATCH",
      "inventory:img-1": "SUBJECT_MATCH",
      "inventory:img-2": "SUBJECT_MATCH",
    },
    ...(anchors ? { subjectAnchors: anchors } : {}),
    previewFetch: { fetchImpl },
  });
}

describe("рамка плитки и запись строки считаются одним ответом", () => {
  it("под признаками субъекта строка со словами должности не выделяется", async () => {
    const visuals = await build(ANCHORS);
    const meta = visuals.visualAssets.p14_ru_images_1?.[0];
    expect(meta?.visibleItems?.map((v) => v.adverse)).toEqual([false, true]);
    // `notShown[].adverse` — тот же ответ, каким красится плитка.
    expect(meta?.notShown?.map((n) => n.adverse)).toEqual([false]);
  });

  it("без признаков субъекта ответ прежний — слова должности краснят строку", async () => {
    const visuals = await build(null);
    const meta = visuals.visualAssets.p14_ru_images_1?.[0];
    expect(meta?.visibleItems?.map((v) => v.adverse)).toEqual([true, true]);
    expect(meta?.notShown?.map((n) => n.adverse)).toEqual([true]);
  });

  it("портрет обложки берётся из подтверждённой ненегативной строки", async () => {
    const visuals = await build(ANCHORS);
    expect(
      visuals.assets.find((a) => a.assetRef === "cover_portrait")?.evidenceRefs
    ).toEqual(["inventory:img-0"]);
  });

  it("без признаков субъекта та же строка портретом не становится", async () => {
    const visuals = await build(null);
    expect(visuals.assets.find((a) => a.assetRef === "cover_portrait")).toBeUndefined();
  });
});
