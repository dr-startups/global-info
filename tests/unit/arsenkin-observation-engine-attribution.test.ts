import { describe, expect, it } from "vitest";
import { resolveObservationEngine } from "../../src/modules/digital-profile/services/arsenkin-tool-adapters";

/**
 * Источник наблюдения называется по факту, а не угадывается.
 *
 * На живом прогоне слайд «Россия — подсказки Яндекса» вышел пустым, а сами
 * подсказки Яндекса встали на слайд Google под ярлыком Google. Замер по
 * композиту: `ARSENKIN | autocomplete | RU` — 34 наблюдения, `YANDEX |
 * autocomplete` — ни одного.
 *
 * Причина: всё, что приходило от Arsenkin, записывалось как
 * `engine: "ARSENKIN"` — сохранялся поставщик данных, а не поисковая система.
 * Ниже по течению это чинили догадкой (`ARSENKIN` → `GOOGLE`), добавленной
 * ради слота органики по ОАЭ, и под неё попали подсказки Яндекса.
 *
 * Догадка не нужна: систему выбираем мы сами при отправке, параметром `se`.
 * В отчёте о должной осмотрительности неверно названный источник хуже
 * отсутствующего, поэтому там, где `se` нет, система не придумывается.
 */

describe("движок наблюдения берётся из запроса", () => {
  it("se=1 — это Яндекс", () => {
    // Подтверждено формой ответа: при se=1 регион приходит яндексовым кодом.
    expect(resolveObservationEngine({ region: 213 }, { tools_name: "suggest", data: { se: 1 } })).toBe(
      "YANDEX"
    );
  });

  it("se=2 — это Google", () => {
    expect(
      resolveObservationEngine({ region: 1011969 }, { tools_name: "suggest", data: { se: 2 } })
    ).toBe("GOOGLE");
  });

  it("без выбора системы источник не придумывается", () => {
    // check-h и indexation работают по списку URL, поисковую систему не выбирают.
    expect(resolveObservationEngine({}, { tools_name: "check-h", data: { mode: "url" } })).toBe(
      "ARSENKIN"
    );
  });

  it("один запрос на обе системы остаётся неатрибутированным", () => {
    // У check-top `se` — массив движков, и отнести строку к одному из них
    // нельзя: назвать наугад значило бы соврать в отчёте.
    const request = {
      tools_name: "check-top",
      data: { se: [{ type: 2, region: 213 }, { type: 11, region: 1011969 }] },
    };
    expect(resolveObservationEngine({}, request)).toBe("ARSENKIN");
  });

  it("значение читается и из ответа, если в запросе его нет", () => {
    expect(resolveObservationEngine({ se: 1 }, undefined)).toBe("YANDEX");
    // Запрос важнее: это наш собственный выбор, а не пересказ провайдера.
    expect(resolveObservationEngine({ se: 2 }, { data: { se: 1 } })).toBe("YANDEX");
  });
});
