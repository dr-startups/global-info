/**
 * Приёмка собирает вход деки тем же загрузчиком, что и продукт.
 *
 * Реплей-скрипт эталона держал собственный загрузчик входов. Тот отстал от
 * продуктового на джойн `composite-serp-provenance.json`: ссылки юнитов вида
 * `inventory:` в индекс не попадали, и построители получали пустые записи —
 * таблица выдачи вырождалась в одну строку, а под снимком панели с четырьмя
 * запросами печаталось «0 связанных запросов». Ворота этого не видели, потому
 * что мерили тем же сломанным индексом.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadReport72DeckInputs } from "../../scripts/run-orion-deck-sections-report72";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { SurfaceAnalysis } from "@/modules/digital-profile/orion-golden/contracts/surface-analysis";

const ANALYTICS_DIR = join(process.cwd(), "baselines", "report-72", "artifacts", "analytics");

const inputs = loadReport72DeckInputs();

describe("вход реплея разрешает ссылки собственных юнитов", () => {
  it("каждая ссылка каждого юнита поверхности несёт заголовок или адрес", () => {
    const surfaceAnalysis = JSON.parse(
      readFileSync(join(ANALYTICS_DIR, "surface-analysis.json"), "utf8")
    ) as Record<string, SurfaceAnalysis>;
    const units = Object.values(surfaceAnalysis).flatMap((sa) => sa.units);
    const refs = units.flatMap((u) => [
      ...u.evidenceRefs,
      ...u.claims.flatMap((c) => c.evidenceRefs),
    ]);
    // Пустой перечень прошёл бы проверку вакуумно — а ровно так она и молчала бы
    // при сломанном чтении артефактов.
    expect(refs.length).toBeGreaterThan(300);
    const unresolved = refs.filter((r) => {
      const e = inputs.evidenceIndex[r];
      return !e || (!e.title && !e.url);
    });
    expect(unresolved.slice(0, 5)).toEqual([]);
    expect(unresolved).toHaveLength(0);
  });

  it("`inventory:`-ссылка отдаёт запись наблюдения, а не пустоту", () => {
    // Точечная регрессия: этот ключ есть только в провенансе, в сырых
    // `obs.evidenceRefs` его нет. Джойн, «упрощённый» обратно на наблюдения,
    // краснеет здесь.
    const entry = inputs.evidenceIndex["inventory:serp-obs-cmrjscznt009xvd9gfqk5wgev"];
    expect(entry?.title).toContain("Кто такой Глинка");
    expect(entry?.region).toBe("RU");
  });
});

describe("KPI приёмки — это KPI продукта", () => {
  const product = loadDeckInputsFromAnalyticsDir(ANALYTICS_DIR);

  it("идентификация и регионы совпадают с продуктовым загрузчиком", () => {
    const identity = (m: typeof inputs.metricSnapshot) => ({
      subjectMatchCount: m.subjectMatchCount,
      likelySubjectCount: m.likelySubjectCount,
      ambiguousCount: m.ambiguousCount,
      otherSubjectCount: m.otherSubjectCount,
      perRegionCounts: m.perRegionCounts,
    });
    expect(identity(inputs.metricSnapshot)).toEqual(identity(product.metricSnapshot));
  });

  it("на данных прогона 72 это 149 / 161 / 33 и Россия 246, ОАЭ 97", () => {
    // Числа продукта: счёт по наблюдениям, а не по решениям инвентаря.
    expect(inputs.metricSnapshot.subjectMatchCount).toBe(149);
    expect(inputs.metricSnapshot.ambiguousCount).toBe(161);
    expect(inputs.metricSnapshot.otherSubjectCount).toBe(33);
    expect(inputs.metricSnapshot.perRegionCounts).toEqual({ RU: 246, UAE: 97 });
  });
});

describe("подсказки покрытия доезжают до приёмки", () => {
  it("пустые поверхности прогона 72 названы статусом сбора", () => {
    // Без них страница пустой поверхности говорит «не собиралась» вместо
    // «проверено, данных нет» — это разные утверждения перед клиентом.
    expect(inputs.surfaceCollectionHints).toHaveLength(15);
    expect(
      inputs.surfaceCollectionHints.every((h) => h.status === "NO_RESULTS")
    ).toBe(true);
    expect(
      inputs.surfaceCollectionHints.some((h) => h.surface === "ai_answer" && h.region === "RU")
    ).toBe(true);
  });
});
