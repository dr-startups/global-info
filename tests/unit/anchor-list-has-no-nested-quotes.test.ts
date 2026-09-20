/**
 * Список признаков печатается без кавычек в кавычках (шаг 0131).
 *
 * Стр. 3 отчёта Мордашова 20.09.2026: «Перед началом сбора оператор назвал
 * признаки проверяемого лица: дата рождения 1965-09-26, «Северсталь»,
 * ««Северсталь»», «Severstal», … «председатель совета директоров
 * «Северстали»», …».
 *
 * Обёртка ставилась поверх того, что уже в ёлочках. Ответ на вопрос «как
 * печатается чужой текст в кавычках» у продукта один — `quoteBody`: он снимает
 * обёртку любого стиля и переводит внутренние ёлочки в лапки. Признак ничем не
 * отличается от цитаты, и печататься обязан тем же способом.
 */

import { describe, expect, it } from "vitest";
import { quoteBody } from "@/modules/digital-profile/orion-golden/client/client-quote";
import { anchorNarrativeLines } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/front-matter";

describe("признак печатается как цитата", () => {
  it("К1: обёртка не удваивается, внутренние ёлочки становятся лапками", () => {
    expect(quoteBody("«Северсталь»")).toBe("Северсталь");
    expect(quoteBody("председатель совета директоров «Северстали»")).toBe(
      "председатель совета директоров „Северстали“"
    );
  });

  it("К2: в абзаце признаков нет ни одной пары «« или »»", () => {
    const lines = anchorNarrativeLines({
      decision: "ANCHORS_CONFIRMED",
      anchors: {
        birthDate: "1965-09-26",
        phrases: [
          { kind: "employer", text: "Северсталь", strong: true },
          { kind: "employer", text: "«Северсталь»", strong: true },
          { kind: "position", text: "председатель совета директоров «Северстали»", strong: true },
        ],
        inn: [],
        domains: ["severstal.com"],
      },
    } as never);
    const text = lines.join(" ");
    expect(text).not.toContain("««");
    expect(text).not.toContain("»»");
    expect(text).toContain("„Северстали“");
    // Повтор признака после снятия обёртки виден и снимается.
    expect(text.match(/«Северсталь»/gu) ?? []).toHaveLength(1);
  });
});
