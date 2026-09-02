/**
 * Приёмка требует телеметрию карточных страниц матрицы.
 *
 * Правило «выброшенное рендерером содержимое поднимает CONTENT_DROPPED_BY_RENDERER»
 * исполняется только там, куда поступает телеметрия. Карточная сетка матрицы её
 * не писала — и страница 6 прогона 72 теряла карточку при двадцати зелёных
 * воротах. Отсутствие записи должно быть отказом, а не пропуском: проверка без
 * входа выглядит ровно так же, как пройденная.
 */

import { describe, expect, it } from "vitest";
import { riskMatrixTelemetryPresent } from "../../scripts/run-orion-deck-sections-report72";

const RISK_PAGES = [
  { template: "orion_golden_risk_matrix_grid", pageNumber: 6 },
  { template: "orion_golden_risk_matrix_grid", pageNumber: 7 },
  { template: "orion_golden_metrics_dashboard", pageNumber: 11 },
];

const entry = (page: number) => ({ page, name: `orion_risk_matrix_p${page}`, role: "cards" });

describe("ворота присутствия телеметрии матрицы", () => {
  it("зелёные, когда запись есть у каждой страницы матрицы", () => {
    expect(riskMatrixTelemetryPresent(RISK_PAGES, { entries: [entry(6), entry(7)] })).toBe(true);
  });

  it("красные, когда у одной страницы записи нет", () => {
    expect(riskMatrixTelemetryPresent(RISK_PAGES, { entries: [entry(6)] })).toBe(false);
  });

  it("красные, когда телеметрии нет вовсе", () => {
    expect(riskMatrixTelemetryPresent(RISK_PAGES, null)).toBe(false);
    expect(riskMatrixTelemetryPresent(RISK_PAGES, { entries: [] })).toBe(false);
  });

  it("красные, когда записи не о карточках матрицы", () => {
    expect(
      riskMatrixTelemetryPresent(RISK_PAGES, {
        entries: [
          { page: 6, name: "orion_text_body_p6", role: "text" },
          { page: 7, name: "orion_text_body_p7", role: "text" },
        ],
      })
    ).toBe(false);
  });

  it("красные, когда страниц матрицы в деке не нашлось — проверять было нечего", () => {
    expect(
      riskMatrixTelemetryPresent(
        [{ template: "orion_golden_metrics_dashboard", pageNumber: 11 }],
        { entries: [entry(6)] }
      )
    ).toBe(false);
  });
});
