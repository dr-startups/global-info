/**
 * Подпись служебного блока выдачи не цитируется как материал.
 *
 * «Картинки по запросу "Тимати биография"» — надпись, которую поисковик рисует
 * над плиткой изображений: у неё нет ни автора, ни содержания, она лишь
 * повторяет запрос. На прогоне 14.08 такая строка стояла доказательством в
 * пяти блоках отчёта, включая резюме для руководства и матрицу рисков.
 */

import { describe, expect, it } from "vitest";
import { looksLikeSurfaceBlockHeading } from "@/modules/digital-profile/orion-golden/analytics/client-quote-hygiene";
import { isWeakExampleTitle } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";

describe("подписи блоков выдачи", () => {
  const headings = [
    'Картинки по запросу "Тимати биография"',
    'Картинки по запросу "тимур ильдарович юнусов дети"',
    "Изображения по запросу Юнусов",
    "Видео по запросу Тимати суд",
    "Новости по запросу Юнусов Тимур",
    "Похожие запросы",
    "Связанные запросы",
    'Images for "Timati biography"',
    "People also ask",
    "People also search for",
    "Related searches",
    "Searches related to Timati",
  ];

  it("узнаются во всех формах, что отдают поверхности", () => {
    for (const h of headings) {
      expect(looksLikeSurfaceBlockHeading(h), h).toBe(true);
      expect(isWeakExampleTitle(h), h).toBe(true);
    }
  });

  it("настоящие заголовки публикаций не задевает", () => {
    const real = [
      "Ukraine issues arrest warrant for pro-Putin Russian rapper Timati",
      "Тимати, биография и музыкальное творчество",
      "ИП Юнусов Тимур Ильдарович зарегистрирован 25.12.2008",
      "Timati has been suspected in Ukraine",
      "Как запросы к банку меняют профиль риска",
    ];
    for (const t of real) expect(looksLikeSurfaceBlockHeading(t), t).toBe(false);
  });

  it("слово «картинки» само по себе материал не отменяет", () => {
    // Отсеивается именно подпись блока, а не любое упоминание изображений.
    expect(looksLikeSurfaceBlockHeading("Картинки с суда над Тимати опубликованы")).toBe(false);
    expect(looksLikeSurfaceBlockHeading("Новости о запросе прокуратуры")).toBe(false);
  });
});
