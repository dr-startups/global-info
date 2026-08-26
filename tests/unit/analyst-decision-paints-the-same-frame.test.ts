/**
 * Рамка на снимке отвечает так же, как оценка в таблице.
 *
 * Негативность нарисованной строки решает не дека: флаг ставит построитель
 * рисованных активов, а он зовёт тот же единственный предикат. Вход у него —
 * сам элемент инвентаря, то есть ровно тот объект, который правки аналитика
 * уже пометили на месте; в вызов флаги просто не передавались.
 *
 * Донести решение только до индекса деки значило бы поссорить отчёт с самим
 * собой: таблица сказала бы «Не проверено» про материал, который через пять
 * страниц обведён красным и объяснён словами «Потенциально негативные
 * публикации».
 */

import { describe, expect, it } from "vitest";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const SUBJECT = "Anders Holmström";

function item(over: Partial<RawInventoryItem> & { inventoryId: string }): RawInventoryItem {
  return {
    caseId: "case-analyst",
    reportRunId: "run-1",
    source: "serper",
    provider: "serper",
    region: "RU",
    query: SUBJECT,
    collectedAt: "2026-08-01T00:00:00.000Z",
    evidenceType: "serp_result",
    title: "Материал",
    snippet: "",
    sourceUrl: "https://example.org/a",
    rawMetadata: { engine: "GOOGLE", surface: "organic", provider: "serper" },
    ...over,
  } as RawInventoryItem;
}

/** Заголовок со словом словаря: без решения аналитика строка краснеет. */
const DICTIONARY_TITLE = "Anders Holmström faces tax-fraud probe in Stockholm";
/** Заголовок, о котором словарь молчит. */
const CLEAN_TITLE = "Anders Holmström, CEO of Nordkap Capital AB — fintech investor profile";

const neutralByAnalyst = item({
  inventoryId: "obs-neutral",
  title: DICTIONARY_TITLE,
  sourceUrl: "https://affarsposten.se/a",
  rawMetadata: {
    engine: "GOOGLE",
    surface: "organic",
    provider: "serper",
    analystNeutral: true,
  },
});
const adverseByAnalyst = item({
  inventoryId: "obs-adverse",
  title: CLEAN_TITLE,
  sourceUrl: "https://finansbladet.se/a",
  rawMetadata: {
    engine: "GOOGLE",
    surface: "organic",
    provider: "serper",
    analystAdverse: true,
  },
});
const untouched = item({
  inventoryId: "obs-plain",
  title: DICTIONARY_TITLE,
  sourceUrl: "https://kriminal-vestnik.se/a",
});

async function snapshotRows(items: RawInventoryItem[]) {
  const visuals = await buildCanonicalVisualAssets({
    subjectName: SUBJECT,
    items,
    allowImagePreviewNetwork: false,
  });
  const rows = (visuals.visualAssets.p10_ru_serp_visual ?? []).flatMap(
    (a) => a.visibleItems ?? []
  );
  return new Map(rows.map((r) => [r.ref, r]));
}

describe("снимок выдачи следует решению аналитика", () => {
  it("снятая аналитиком метка снимает и рамку", async () => {
    const rows = await snapshotRows([neutralByAnalyst, untouched]);
    expect(rows.get("inventory:obs-plain")?.adverse).toBe(true);
    expect(rows.get("inventory:obs-neutral")?.adverse).toBe(false);
  });

  it("поставленная аналитиком метка ставит рамку там, где словарь молчал", async () => {
    const rows = await snapshotRows([adverseByAnalyst, untouched]);
    expect(rows.get("inventory:obs-adverse")?.adverse).toBe(true);
  });
});

describe("плитка сетки изображений следует тому же решению", () => {
  function imageItem(over: Partial<RawInventoryItem> & { inventoryId: string }) {
    return item({
      evidenceType: "image",
      imageUrl: "https://example.org/a.jpg",
      rawMetadata: { engine: "GOOGLE", surface: "images", provider: "serper" },
      ...over,
    });
  }

  async function gridRow(items: RawInventoryItem[], ref: string) {
    const visuals = await buildCanonicalVisualAssets({
      subjectName: SUBJECT,
      items,
      allowImagePreviewNetwork: false,
    });
    const metas = visuals.visualAssets["p14_ru_images_1"] ?? [];
    return metas.flatMap((m) => m.notShown ?? []).find((n) => n.ref === ref);
  }

  it("снятая метка — плитка без рамки", async () => {
    const marked = imageItem({
      inventoryId: "img-neutral",
      title: DICTIONARY_TITLE,
      sourceUrl: "https://affarsposten.se/img",
      imageUrl: "https://affarsposten.se/img.jpg",
      rawMetadata: {
        engine: "GOOGLE",
        surface: "images",
        provider: "serper",
        analystNeutral: true,
      },
    });
    const plain = imageItem({
      inventoryId: "img-plain",
      title: DICTIONARY_TITLE,
      sourceUrl: "https://kriminal-vestnik.se/img",
      imageUrl: "https://kriminal-vestnik.se/img.jpg",
    });
    expect((await gridRow([plain], "inventory:img-plain"))?.adverse).toBe(true);
    expect((await gridRow([marked], "inventory:img-neutral"))?.adverse).toBe(false);
  });

  it("поставленная метка — плитка с рамкой", async () => {
    const marked = imageItem({
      inventoryId: "img-adverse",
      title: CLEAN_TITLE,
      sourceUrl: "https://finansbladet.se/img",
      imageUrl: "https://finansbladet.se/img.jpg",
      rawMetadata: {
        engine: "GOOGLE",
        surface: "images",
        provider: "serper",
        analystAdverse: true,
      },
    });
    expect((await gridRow([marked], "inventory:img-adverse"))?.adverse).toBe(true);
  });
});
