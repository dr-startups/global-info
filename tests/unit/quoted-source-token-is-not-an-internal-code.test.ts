/**
 * Токен из заголовка источника — не внутренний код.
 *
 * Живой прогон 04.09 (DPA-2026-0053, враждебный корпус шага 0056): в заголовке
 * страницы выдачи стояло название канала `ROSNEFT_OIL`. Дека цитирует заголовок
 * на странице таблицы выдачи, на визуальной странице и в её карточке «почему» —
 * три страницы, и ворота остановили оплаченный отчёт: «внутренние коды в
 * клиентском тексте на 3 страницах … коды: ROSNEFT_OIL».
 *
 * По форме название канала и наша константа неотличимы, но происхождение
 * различимо: наш код ниоткуда не цитируется, а название канала стоит в
 * заголовке улики. Правило то же, что у ворот чужих доменов: текст, взятый из
 * улики, — не наш текст, и судить его как наш нельзя.
 */

import { describe, expect, it } from "vitest";
import {
  findInternalCodes,
  scanDeckForInternalCodes,
  type ClientVisibleSlide,
} from "@/modules/digital-profile/orion-golden/deck-sections/internal-code-scan";

const SOURCE_TITLE = "ROSNEFT_OIL — официальный канал компании в Telegram";
const OUR_CODE = "VISUAL_ASSET_UNAVAILABLE";

function slide(key: string, text: string): ClientVisibleSlide {
  return { slideKey: key, bullets: [text] };
}

const THREE_PAGES = [
  slide("p26_uae_serp_table", `Заголовок: ${SOURCE_TITLE}`),
  slide("p27_uae_serp_visual", `В выдаче виден канал ${SOURCE_TITLE}`),
  slide("p27_uae_serp_visual__why1", `Почему в выдаче: ${SOURCE_TITLE}`),
];

describe("токен из заголовка источника — не внутренний код", () => {
  it("по форме токен по-прежнему код: без улики его нельзя отличить от нашего", () => {
    expect(findInternalCodes(SOURCE_TITLE)).toEqual(["ROSNEFT_OIL"]);
    expect(scanDeckForInternalCodes(THREE_PAGES).map((f) => f.slide)).toEqual([
      "p26_uae_serp_table",
      "p27_uae_serp_visual",
      "p27_uae_serp_visual__why1",
    ]);
  });

  it("токен, стоящий в тексте улики, кодом не считается ни на одной странице", () => {
    expect(scanDeckForInternalCodes(THREE_PAGES, { quotedTexts: [SOURCE_TITLE] })).toEqual([]);
  });

  it("улика с тем же токеном не прикрывает наш код на тех же страницах", () => {
    const withOurCode = [
      ...THREE_PAGES,
      slide("p12_ru_profile", `Экспорт недоступен (${OUR_CODE}); ${SOURCE_TITLE}`),
    ];
    expect(scanDeckForInternalCodes(withOurCode, { quotedTexts: [SOURCE_TITLE] })).toEqual([
      { slide: "p12_ru_profile", code: OUR_CODE },
    ]);
  });

  it("совпадение — по целому токену улики, а не по подстроке", () => {
    // `ROSNEFT_OIL_EXPORT` в улике не оправдывает `ROSNEFT_OIL` в нашем тексте:
    // это уже не цитата.
    expect(
      scanDeckForInternalCodes(THREE_PAGES, { quotedTexts: ["Канал ROSNEFT_OIL_EXPORT"] })
    ).toHaveLength(3);
  });
});
