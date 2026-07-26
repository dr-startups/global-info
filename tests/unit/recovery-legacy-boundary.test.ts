import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Шаг 12.4e (docs/rework/12-durable-step-execution.md).
 *
 * «Где мы остановились» отвечали двое: `planResumeFromSteps` по строкам шагов и
 * прежняя эвристика по шести полям джобы. Именно в эвристике нашлись дефекты
 * 08.0-bis и 11.1 — состояние «пять прогонов зарегистрировано, задач две»
 * проходило её проверку.
 *
 * Сегодня для любого прогона с конвейером эвристика недостижима. Она осталась
 * ровно для прогонов без конвейера и для сбоя чтения таблицы шагов, и вынесена
 * отдельно, чтобы две реализации одного вопроса не жили в одном файле.
 */

const SERVICES = join(process.cwd(), "src/modules/digital-profile/services");
const read = (f: string) => readFileSync(join(SERVICES, f), "utf8");

describe("две реализации «где мы остановились» разведены", () => {
  it("основной модуль спрашивает шаги и делегирует остальное", () => {
    const src = read("unified-collection-recovery.ts");
    expect(src).toContain("planResumeFromSteps");
    expect(src).toContain("evaluateLegacyRecoveryEligibility");
  });

  it("эвристика по полям джобы из основного модуля ушла", () => {
    const src = read("unified-collection-recovery.ts");
    // Признаки прежнего вывода: счёт прогонов и флаг полноты из блоба.
    expect(src).not.toMatch(/enrichmentCount >= 5/u);
    expect(src).not.toMatch(/arsenkinEnrichmentState\?\.enrichmentComplete/u);
  });

  it("легаси-модуль объясняет, почему он ещё жив", () => {
    const src = read("unified-recovery-legacy-heuristic.ts");
    expect(src).toMatch(/недостижим/u);
    expect(src).toMatch(/до шага 12/iu);
  });

  it("основной модуль стал заметно короче", () => {
    // Разведение — не косметика: 844 строки с двумя реализациями внутри
    // читались как одна логика, и это скрывало дубль.
    const lines = read("unified-collection-recovery.ts").split("\n").length;
    expect(lines).toBeLessThan(720);
  });
});
