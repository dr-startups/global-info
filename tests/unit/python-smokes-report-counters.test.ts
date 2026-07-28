/**
 * Python-смоки сообщают раннеру, сколько проверок выполнили.
 *
 * Раннер держит правило «прогон без единой выполненной проверки — провал» на
 * TAP-счётчиках (`# tests` / `# pass`). Python-смоки их не печатали, счётчики
 * приходили `undefined`, и правило к ним не применялось вовсе: смок, не
 * выполнивший ни одной проверки и вышедший с нулём, показывался как «ок».
 *
 * Это тот самый исход, ради которого раннер и написан, — просто в слепой зоне.
 * Замер: до правки `ci:smokes:full` показывал 77 пройденных проверок при двух
 * Python-смоках, после — 108.
 *
 * Свойство: каждый Python-смок из реестра печатает счётчики.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCounters } from "../../scripts/run-smokes";

const RUNNER = readFileSync(join(process.cwd(), "scripts/run-smokes.ts"), "utf8");

/** Пути python-смоков, объявленных в реестре раннера. */
function registeredPythonSmokes(): string[] {
  return [...RUNNER.matchAll(/argv:\s*\["PYTHON",\s*"([^"]+)"\]/gu)].map((m) => m[1]!);
}

describe("Python-смоки и счётчики проверок", () => {
  const smokes = registeredPythonSmokes();

  it("реестр содержит python-смоки", () => {
    expect(smokes.length).toBeGreaterThan(0);
  });

  it("каждый печатает счётчики в понятном раннеру виде", () => {
    for (const rel of smokes) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, `${rel} не печатает счётчики`).toContain("print_tap_counters");
    }
  });

  it("формат счётчиков разбирается тем же парсером, что и TAP", () => {
    const counters = parseCounters(["# tests 8", "# pass 8", "# fail 0"].join("\n"));
    expect(counters.tests).toBe(8);
    expect(counters.pass).toBe(8);
    expect(counters.fail).toBe(0);
  });

  it("прогон без выполненных проверок различим по счётчикам", () => {
    // Ровно то, что раньше выглядело успехом.
    const counters = parseCounters(["# tests 0", "# pass 0", "# fail 0"].join("\n"));
    expect(counters.tests).toBe(0);
    expect(counters.pass).toBe(0);
  });
});
