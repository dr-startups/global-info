/**
 * Строка выдачи, которая материала не называет, ни с кем не сводится.
 *
 * Таблица выдачи склеивает наблюдения одной страницы в одну строку: ключ
 * наблюдения включает запрос, а читателю страница одна. У строки, за которой
 * нет ни адреса, ни домена, сводить нечего — и склеенная с такой же она молча
 * теряет свою позицию и свой заголовок. Ответ на «какой материал стоит за
 * ссылкой индекса» у слоя деки один (`evidenceMaterialKey`), и таблица
 * пользуется им же: собственный вызов без запасного ключа давал второй ответ.
 */

import { describe, expect, it } from "vitest";
import { mergeSerpRowsByMaterial } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

function scoped(evidenceIndex: Record<string, unknown>): ScopedFragmentInput {
  return {
    findings: [],
    surfaceUnits: [],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

describe("сведение строк выдачи по материалу", () => {
  it("одна страница, найденная двумя запросами, — одна строка", () => {
    const material = { title: "Суд по иску о взыскании", domain: "dzen.ru" };
    const merged = mergeSerpRowsByMaterial(
      ["ev-q1", "ev-q2"],
      scoped({
        "ev-q1": { ...material, url: "https://dzen.ru/a?q=1" },
        "ev-q2": { ...material, url: "https://dzen.ru/a?q=2" },
      })
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]!.refs).toEqual(["ev-q1", "ev-q2"]);
  });

  it("две статьи одного сайта остаются двумя строками", () => {
    const merged = mergeSerpRowsByMaterial(
      ["ev-1", "ev-2"],
      scoped({
        "ev-1": { title: "Первая", domain: "dzen.ru", url: "https://dzen.ru/a" },
        "ev-2": { title: "Вторая", domain: "dzen.ru", url: "https://dzen.ru/b" },
      })
    );
    expect(merged).toHaveLength(2);
  });

  it("ссылки, которых нет в индексе, не складываются в одну строку", () => {
    const merged = mergeSerpRowsByMaterial(["ev-1", "ev-2"], scoped({}));
    expect(merged).toHaveLength(2);
    expect(merged.map((m) => m.refs)).toEqual([["ev-1"], ["ev-2"]]);
  });

  it("записи без адреса и домена не склеиваются по одинаковому заголовку", () => {
    // Заголовок записи базы — имя субъекта, и он одинаков у всех баз: на
    // корпусе `report-72` три записи сошлись бы в один ключ «|имя».
    const record = { title: "Кремлёв Умар Назарович", kind: "compliance_hit" };
    const merged = mergeSerpRowsByMaterial(
      ["ev-dj", "ev-lexis"],
      scoped({ "ev-dj": { ...record }, "ev-lexis": { ...record } })
    );
    expect(merged).toHaveLength(2);
  });
});
