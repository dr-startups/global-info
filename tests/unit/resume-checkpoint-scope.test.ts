import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UNIFIED_PIPELINE } from "../../src/modules/digital-profile/workflow/step-plan";

/**
 * Шаг 12.4c.
 *
 * Прогресс был представлен трижды: `stage`, `resumeCheckpoint` и блоб
 * `arsenkinEnrichmentState`. Все дефекты 08.0-bis и 11.1 были расхождениями
 * между этими тремя.
 *
 * `resumeCheckpoint` со значениями `BASE_COLLECTION` и `ARSENKIN_ENRICHMENT`
 * просто повторял стадию — и никем не читался. Оставшиеся значения отвечают на
 * другой вопрос: где прогон остановился **внутри** шага. Шаг
 * `ARSENKIN_ENRICHMENT` — это и отправка задач, и опрос, и приём результата;
 * `REPORT_PREPARE` — подготовка, генерация текста и рендер. Этого шаги не
 * выражают, поэтому поле остаётся, но только в своей области.
 */

const TYPES_PATH = join(
  process.cwd(),
  "src/modules/digital-profile/services/unified-collection-types.ts"
);

/** Значения `resumeCheckpoint` из объявления типа. */
function declaredCheckpoints(): string[] {
  const src = readFileSync(TYPES_PATH, "utf8");
  const start = src.indexOf("resumeCheckpoint?:");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(";", start);
  return [...src.slice(start, end).matchAll(/"([A-Z_]+)"/gu)].map((m) => m[1]!);
}

describe("контрольная точка живёт внутри шага, а не рядом со стадией", () => {
  it("ни одно значение не повторяет имя шага конвейера", () => {
    const stepNames = new Set<string>(UNIFIED_PIPELINE.map((d) => d.name));
    const stageNames = new Set<string>(UNIFIED_PIPELINE.map((d) => d.stage));
    // `ORION_PREPARE` остаётся только как принимаемое при чтении значение
    // прогонов до переименования; записывается уже `ASSEMBLY`.
    const legacyRead = new Set(["ORION_PREPARE"]);
    const offenders = declaredCheckpoints().filter(
      (v) => !legacyRead.has(v) && (stepNames.has(v) || stageNames.has(v))
    );
    expect(offenders).toEqual([]);
  });

  it("проверка ловит возврат дубля", () => {
    // Иначе тест выше зелен по любой причине, включая пустой разбор типа.
    const stepNames = new Set<string>(UNIFIED_PIPELINE.map((d) => d.name));
    expect(stepNames.has("BASE_COLLECTION")).toBe(true);
    expect(stepNames.has("ARSENKIN_ENRICHMENT")).toBe(true);
  });

  it("внутришаговые значения сохранены", () => {
    // Их удаление требует вывода состояния из ProviderTask: ARSENKIN_RESULT_INGEST
    // отделяет «задачи отправлены» от «ещё нет», то есть охраняет платную отправку.
    expect(declaredCheckpoints()).toEqual(
      expect.arrayContaining([
        "ARSENKIN_RESULT_INGEST",
        "PRE_RENDER_DATA_GATE",
        "ASSEMBLY",
        "RENDER",
        "GPT_COPY",
      ])
    );
  });

  it("оркестратор больше не пишет стадию в контрольную точку", () => {
    const src = readFileSync(
      join(
        process.cwd(),
        "src/modules/digital-profile/services/unified-orion-collection-orchestrator.ts"
      ),
      "utf8"
    );
    expect(src).not.toMatch(/resumeCheckpoint: "BASE_COLLECTION"/u);
    expect(src).not.toMatch(/resumeCheckpoint: "ARSENKIN_ENRICHMENT"/u);
    // Записывается новое имя; старое только читается.
    expect(src).not.toMatch(/\("ORION_PREPARE" as const\)/u);
  });
});
