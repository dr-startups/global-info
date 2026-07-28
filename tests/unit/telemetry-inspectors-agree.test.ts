/**
 * Два инспектора телеметрии отвечают на один вопрос одинаково.
 *
 * «Потерял ли рендерер содержимое» решалось в двух местах:
 *
 *   · TS  — `inspectLayoutTelemetry`: есть `CONTENT_DROPPED_BY_RENDERER`
 *           уровня CRITICAL, покрыт тестом;
 *   · Py  — `scripts/inspect-first36-pptx-geometry.py`: правила не было вовсе.
 *
 * Прогон деки зовёт **Python**. То есть строгое правило, записанное в
 * ENGINEERING.md как CRITICAL, не исполнялось никогда: на эталонной деке
 * выброшенные буллеты страниц 11 и 29 докладывались как `text-clipping` —
 * «текст обрезан» вместо «содержимое до клиента не дошло».
 *
 * Свойство: на одной и той же телеметрии оба инспектора дают один код.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inspectLayoutTelemetry } from "../../src/modules/digital-profile/orion-golden/classic/generate-first36-geometry-artifacts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const PY_INSPECTOR = join(process.cwd(), "scripts/inspect-first36-pptx-geometry.py");

function telemetryFile(entries: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), "telemetry-"));
  const path = join(dir, "layout-telemetry.json");
  writeFileSync(
    path,
    JSON.stringify({ version: "orion-layout-telemetry-v1", entries }, null, 2),
    "utf8"
  );
  return path;
}

const DROPPED = {
  page: 11,
  name: "orion_bullets_dropped_p11",
  role: "bullets",
  clipped: true,
  droppedBullets: 1,
  droppedLines: 0,
  requiredHeight: 2_937_723,
  availableHeight: 1_563_360,
};

describe("инспекторы телеметрии и потеря содержимого", () => {
  it("TS называет выброшенное содержимое своим именем", () => {
    const issues = inspectLayoutTelemetry(telemetryFile([DROPPED]));
    expect(issues.map((i) => i.code)).toContain("CONTENT_DROPPED_BY_RENDERER");
    expect(issues[0]!.severity).toBe("CRITICAL");
  });

  it("выброшенное содержимое не выдаётся за обрезку текста", () => {
    // Разница существенная: обрезка — «видно не всё», потеря — «не дошло
    // вовсе». Пока это был один код, второе читалось как первое.
    const issues = inspectLayoutTelemetry(telemetryFile([DROPPED]));
    expect(issues.map((i) => i.code)).not.toContain("text-clipping");
  });

  it("обрезка без потери остаётся обрезкой", () => {
    const clippedOnly = { ...DROPPED, droppedBullets: 0, droppedLines: 0 };
    const issues = inspectLayoutTelemetry(telemetryFile([clippedOnly]));
    expect(issues.map((i) => i.code)).toContain("text-clipping");
    expect(issues.map((i) => i.code)).not.toContain("CONTENT_DROPPED_BY_RENDERER");
  });

  it("Python-инспектор знает то же правило", () => {
    // Прогон зовёт именно его; без этой проверки правило снова может остаться
    // только в TS, где его никто не исполняет.
    const src = readFileSync(PY_INSPECTOR, "utf8");
    expect(src).toContain("CONTENT_DROPPED_BY_RENDERER");
    expect(src).toMatch(/droppedBullets/u);
    // Ветка потери обязана стоять раньше ветки обрезки: у выброшенного блока
    // `clipped` тоже true, и при обратном порядке правило снова замолчит.
    expect(src.indexOf("CONTENT_DROPPED_BY_RENDERER")).toBeLessThan(
      src.indexOf('"code": "text-clipping"')
    );
  });
});
