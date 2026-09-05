/**
 * На обложке — лицо проверяемого, а не первая картинка выдачи.
 *
 * Отчёт 85: портрет на обложке взят из первой разрешившейся плитки RU-сетки —
 * профиля сотрудника РНИМУ (`rsmu.ru`, «признаков субъекта нет»), то есть
 * однофамильца-офтальмолога. Фотографии самого судьи лежали в той же сетке.
 * Обложка — первое, что видит клиент, и чужое лицо на ней обесценивает отчёт
 * целиком.
 *
 * Портрет берётся только из строки, о которой решение говорит «о субъекте», и
 * только из ненегативной: обложка не место для кадра из криминального сюжета.
 * Такой строки нет — рисуется графика бренда, как и при полном отсутствии
 * превью.
 */

import { describe, expect, it, vi } from "vitest";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import { svgToPngBase64 } from "@/modules/digital-profile/orion-golden/assets/media-asset-svg";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

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

function imageRow(i: number, title: string): RawInventoryItem {
  return {
    inventoryId: `img-${i}`,
    caseId: "case-egorov",
    reportRunId: "run-1",
    source: "serper",
    provider: "serper",
    region: "RU",
    query: "Егоров Алексей Евгеньевич",
    collectedAt: "2026-09-04T12:00:00.000Z",
    evidenceType: "image_result",
    title,
    snippet: title,
    sourceUrl: `https://site-${i}.ru/page-${i}`,
    imageUrl: `https://cdn.site-${i}.ru/img-${i}.jpg`,
    rawMetadata: { surface: "images", engine: "GOOGLE" },
  };
}

const OPHTHALMOLOGIST = imageRow(0, "РНИМУ им. Н.И. Пирогова - профиль сотрудника");
const JUDGE = imageRow(1, "Егоров Алексей Евгеньевич на портале Право.ру");
const JUDGE_ADVERSE = imageRow(2, "Егоров Алексей Евгеньевич: уголовное дело о коррупции");

async function build(rows: RawInventoryItem[], decisions: Record<string, string>) {
  const fetchImpl = vi.fn(async () => imageResponse(TILE_PNG));
  return buildCanonicalVisualAssets({
    subjectName: "Егоров Алексей Евгеньевич",
    items: rows,
    subjectDecisionByRef: decisions,
    previewFetch: { fetchImpl: fetchImpl as unknown as typeof fetch },
  });
}

describe("портрет обложки — подтверждённая строка", () => {
  it("первая плитка о другом лице — портрет берётся из подтверждённой", async () => {
    const visuals = await build([OPHTHALMOLOGIST, JUDGE], {
      "inventory:img-0": "INSUFFICIENT_IDENTIFIERS",
      "inventory:img-1": "SUBJECT_MATCH",
    });
    const cover = visuals.assets.find((a) => a.assetRef === "cover_portrait");
    expect(cover?.evidenceRefs).toEqual(["inventory:img-1"]);
  });

  it("подтверждённых строк нет — портрета нет вовсе", async () => {
    const visuals = await build([OPHTHALMOLOGIST], {
      "inventory:img-0": "INSUFFICIENT_IDENTIFIERS",
    });
    expect(visuals.assets.find((a) => a.assetRef === "cover_portrait")).toBeUndefined();
  });

  it("негативная строка уступает нейтральной, даже стоя выше", async () => {
    const visuals = await build([JUDGE_ADVERSE, JUDGE], {
      "inventory:img-2": "SUBJECT_MATCH",
      "inventory:img-1": "SUBJECT_MATCH",
    });
    const cover = visuals.assets.find((a) => a.assetRef === "cover_portrait");
    expect(cover?.evidenceRefs).toEqual(["inventory:img-1"]);
  });

  it("подтверждённые плитки стоят в сетке первыми", async () => {
    const visuals = await build([OPHTHALMOLOGIST, JUDGE], {
      "inventory:img-0": "INSUFFICIENT_IDENTIFIERS",
      "inventory:img-1": "SUBJECT_MATCH",
    });
    expect(visuals.visualAssets.p14_ru_images_1?.[0]?.visibleItems?.map((v) => v.ref)).toEqual([
      "inventory:img-1",
      "inventory:img-0",
    ]);
  });
});
