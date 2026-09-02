/**
 * Заголовок, которого поисковик не отдал, берётся у той же страницы.
 *
 * Тот же адрес, найденный другим запросом или в другом контуре, часто приходит
 * **с** заголовком: на эталоне-72 четыре из шести строк, печатавших свой адрес,
 * имеют настоящий заголовок в наблюдении ОАЭ (`techcult.ru`, `labyrinth.ru`,
 * `utro.ru`, `x.com`). Не доезжали они потому, что фрагмент региона видит
 * только наблюдения своего региона, а сведение по материалу идёт внутри
 * фрагмента.
 *
 * Заимствуется **одно поле**. Регион, тип источника, оценка и ссылки на
 * наблюдения не трогаются: уехавшая вместе с заголовком ссылка чужого региона
 * покраснела бы воротом `regionScopeIsolation`.
 *
 * Свойство: донор — запись **того же материала** (ключ `serpMaterialKey`), у
 * которой заголовок адресом не является; выбор детерминирован.
 */

import { describe, expect, it } from "vitest";
import { borrowTitlesWithinMaterial } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

function index(entries: Record<string, Record<string, unknown>>): ScopedEvidenceIndex {
  return entries as unknown as ScopedEvidenceIndex;
}

const RU = {
  url: "https://utro.ru/release/2025/08/01/1563439.shtml",
  domain: "utro.ru",
  region: "RU",
  engine: "GOOGLE",
  sourceType: "news",
};
const UAE = { ...RU, region: "UAE", sourceType: "blog" };

describe("заголовок берётся у записи того же материала", () => {
  it("запись с заголовком-адресом получает заголовок соседа", () => {
    const idx = index({
      ru: { ...RU, title: RU.url },
      uae: { ...UAE, title: "Бизнесмен Сергей Глинка: биография, личная жизнь ..." },
    });
    borrowTitlesWithinMaterial(idx);
    expect((idx.ru as { title?: string }).title).toBe(
      "Бизнесмен Сергей Глинка: биография, личная жизнь ..."
    );
  });

  it("заимствуется только заголовок", () => {
    const idx = index({
      ru: { ...RU, title: RU.url, evidenceRefs: ["ru-only"] },
      uae: { ...UAE, title: "Настоящий заголовок", evidenceRefs: ["uae-only"] },
    });
    borrowTitlesWithinMaterial(idx);
    const ru = idx.ru as Record<string, unknown>;
    expect(ru.region).toBe("RU");
    expect(ru.sourceType).toBe("news");
    expect(ru.evidenceRefs).toEqual(["ru-only"]);
  });

  it("заголовок не заимствуется у записи с другим адресом", () => {
    // `rupep.org/ru/person/8095` и `/en/person/8095` — разные страницы; взяв
    // заголовок у первой для второй, работа завела бы тот же дефект, что чинит.
    const idx = index({
      ru: {
        url: "https://rupep.org/ru/person/8095",
        domain: "rupep.org",
        title: "https://rupep.org/ru/person/8095",
      },
      en: {
        url: "https://rupep.org/en/person/8095",
        domain: "rupep.org",
        title: "PEP: Glinka Sergey Mikhaylovich",
      },
    });
    borrowTitlesWithinMaterial(idx);
    expect((idx.ru as { title?: string }).title).toBe("https://rupep.org/ru/person/8095");
  });

  it("у всех записей материала заголовок адресом — ничего не подставляется", () => {
    const idx = index({
      a: { ...RU, title: RU.url },
      b: { ...UAE, title: RU.url },
    });
    expect(borrowTitlesWithinMaterial(idx)).toBe(0);
    expect((idx.a as { title?: string }).title).toBe(RU.url);
  });

  it("выбор при двух кандидатах детерминирован", () => {
    const build = () =>
      index({
        ru: { ...RU, title: RU.url },
        uae1: { ...UAE, title: "Заголовок Б" },
        uae2: { ...UAE, title: "Заголовок А" },
      });
    const first = build();
    borrowTitlesWithinMaterial(first);
    const second = build();
    borrowTitlesWithinMaterial(second);
    expect((first.ru as { title?: string }).title).toBe((second.ru as { title?: string }).title);
  });

  it("чаще отданный заголовок сильнее редкого", () => {
    const idx = index({
      ru: { ...RU, title: RU.url },
      uae1: { ...UAE, title: "Часто отданный" },
      uae2: { ...UAE, title: "Часто отданный" },
      uae3: { ...UAE, title: "Одинокий" },
    });
    borrowTitlesWithinMaterial(idx);
    expect((idx.ru as { title?: string }).title).toBe("Часто отданный");
  });

  it("хороший заголовок не переписывается", () => {
    const idx = index({
      ru: { ...RU, title: "Свой хороший заголовок" },
      uae: { ...UAE, title: "Чужой заголовок" },
    });
    expect(borrowTitlesWithinMaterial(idx)).toBe(0);
    expect((idx.ru as { title?: string }).title).toBe("Свой хороший заголовок");
  });

  it("повторный проход ничего не меняет", () => {
    const idx = index({
      ru: { ...RU, title: RU.url },
      uae: { ...UAE, title: "Настоящий заголовок" },
    });
    expect(borrowTitlesWithinMaterial(idx)).toBe(1);
    expect(borrowTitlesWithinMaterial(idx)).toBe(0);
  });
});
