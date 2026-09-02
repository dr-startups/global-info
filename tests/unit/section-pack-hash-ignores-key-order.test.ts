/**
 * Пакет секции опознаётся содержимым, а не порядком ключей в памяти.
 *
 * Слайды доезжают до хэша двумя путями: прямо от построителя (ключи `content`
 * стоят в том порядке, в каком их написал автор фрагмента) и из кэша на диске,
 * где пакет разобран схемой (порядок объявления полей). Пока `contentHash`
 * считался по `JSON.stringify` как есть, одно и то же содержимое получало два
 * разных `sha256:` — и файл, переписанный прогоном на тёплом кэше, переставал
 * сходиться с собственным хэшем.
 *
 * Имя берётся из барреля: проверяется публичный контракт «чем пакет
 * опознаётся», а не файл, в котором сегодня живёт формула.
 */

import { describe, expect, it } from "vitest";
import { contentHashOf } from "@/modules/digital-profile/orion-golden/deck-sections";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

type SlideBody = SlideContentContract["content"];

function slide(content: SlideBody): SlideContentContract {
  return {
    schemaVersion: "slide-content-v1",
    slideId: "p12_ru_serp",
    baseSlotId: "p12_ru_serp",
    sectionId: "RU_PROFILE",
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    templateId: "search-table",
    title: "Поисковая выдача — Россия",
    content,
    evidenceRefs: ["inventory:obs-01"],
    findingIds: ["finding-01"],
    metrics: { displayed: 20 },
    visualAssetRefs: [],
  };
}

describe("contentHash пакета секции", () => {
  it("не зависит от порядка ключей в теле слайда", () => {
    // Слева — порядок построителя (`ru/serp.json` эталона), справа — порядок
    // объявления схемы, в котором тот же слайд возвращается из кэша.
    const builderOrder = slide({
      table: { headers: ["№", "Заголовок"], rows: [["1", "Публикация"]] },
      whatWasFound: "Найдено 20 материалов.",
      narrative: "В выдаче преобладают деловые публикации.",
    });
    const schemaOrder = slide({
      narrative: "В выдаче преобладают деловые публикации.",
      table: { headers: ["№", "Заголовок"], rows: [["1", "Публикация"]] },
      whatWasFound: "Найдено 20 материалов.",
    });

    expect(contentHashOf([schemaOrder])).toBe(contentHashOf([builderOrder]));
  });

  it("не зависит от порядка ключей во вложенных объектах", () => {
    const one = slide({
      table: { headers: ["№"], rows: [["1"]], groups: [{ rowStart: 0, rowCount: 1, queryDisplay: "запрос" }] },
      kpis: [{ label: "Материалов", value: "20", tone: "neutral" }],
    });
    const other = slide({
      table: { groups: [{ queryDisplay: "запрос", rowCount: 1, rowStart: 0 }], rows: [["1"]], headers: ["№"] },
      kpis: [{ tone: "neutral", value: "20", label: "Материалов" }],
    });

    expect(contentHashOf([other])).toBe(contentHashOf([one]));
  });

  it("не зависит от порядка полей самого слайда", () => {
    const direct = slide({ narrative: "Текст." });
    const reordered = Object.fromEntries(
      Object.entries(direct).reverse()
    ) as unknown as SlideContentContract;

    expect(contentHashOf([reordered])).toBe(contentHashOf([direct]));
  });

  it("меняется, когда меняется содержимое", () => {
    // Без этой проверки хэш, игнорирующий вообще всё, прошёл бы предыдущие три.
    const before = slide({ narrative: "В выдаче преобладают деловые публикации." });
    const after = slide({ narrative: "В выдаче преобладают судебные публикации." });

    expect(contentHashOf([after])).not.toBe(contentHashOf([before]));
  });
});
