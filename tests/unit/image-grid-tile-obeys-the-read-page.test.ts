/**
 * Плитка сетки изображений подчиняется прочитанной странице.
 *
 * Красную рамку на сетке ставит построитель ассета, и до этого он судил
 * строку только словарём: страница, которую открыли и признали благоприятной,
 * всё равно получала рамку, а текст рядом её опровергал. Карта решений теперь
 * доезжает и сюда — тем же параметром `verdictByRef`, что у снимка и панелей.
 */

import { describe, expect, it } from "vitest";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import type { ObservationVerdictByRef } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const REF = "inventory:img-court";

/** Строка сетки с негативным по словарю заголовком. */
const ITEM = {
  inventoryId: "img-court",
  caseId: "case-unit-image-grid-verdict",
  reportRunId: "run-1",
  source: "serper",
  provider: "serper",
  region: "RU",
  query: "Умар Кремлёв",
  collectedAt: "2026-08-01T00:00:00.000Z",
  evidenceType: "image",
  title: "Суд назначил слушание по делу федерации",
  snippet: "",
  sourceUrl: "https://news-example.ru/court/1",
  imageUrl: "https://news-example.ru/court/1.jpg",
  rawMetadata: { engine: "GOOGLE", surface: "images", provider: "serper" },
} as unknown as RawInventoryItem;

/**
 * Превью офлайн не получить, поэтому строка уходит в `notShown` — но признак
 * негатива ей построитель проставляет до попытки загрузки, тем же вызовом
 * классификатора, что и нарисованной плитке.
 */
async function gridRow(verdictByRef?: ObservationVerdictByRef) {
  const visuals = await buildCanonicalVisualAssets({
    subjectName: "Умар Кремлёв",
    items: [ITEM],
    allowImagePreviewNetwork: false,
    ...(verdictByRef ? { verdictByRef } : {}),
  });
  const metas = visuals.visualAssets["p14_ru_images_1"] ?? [];
  return metas.flatMap((m) => m.notShown ?? []).find((n) => n.ref === REF);
}

describe("решение по прочитанной странице доезжает до сетки изображений", () => {
  it("без карты решений рамку назначает словарь", async () => {
    expect((await gridRow())?.adverse).toBe(true);
  });

  it("прочитанная и признанная благоприятной страница рамку снимает", async () => {
    const row = await gridRow({
      [REF]: { tone: "supportive", quoted: true, subjectMatch: "subject" },
    });
    expect(row?.adverse).toBe(false);
  });

  it("прочитанная и признанная нежелательной — ставит, даже без слов словаря", async () => {
    const row = await gridRow({
      [REF]: { tone: "adverse", quoted: true, subjectMatch: "subject" },
    });
    expect(row?.adverse).toBe(true);
  });
});
