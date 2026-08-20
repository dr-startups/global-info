import { describe, expect, it } from "vitest";
import {
  resolveEmptySurfaceCollection,
  type ScopedFragmentInput,
  type SurfaceCollectionHint,
} from "@/modules/digital-profile/orion-golden/deck-sections";

/**
 * Шаг AO. Причину пустой страницы выбирают данные, а не порядок конкатенации
 * ячеек покрытия.
 *
 * На составе по умолчанию (`ai-serp` выключен) по паре RU/YANDEX/ai_answers
 * приходят **две** ячейки NOT_COLLECTED: «инструмент не входил в состав» и
 * «провайдер не настроен». Первая описывает решение, которое владелец менять не
 * собирался; вторая — то, что он может исправить одной переменной. Печатать
 * надо ту, по которой можно действовать.
 */

const scoped = (hints: SurfaceCollectionHint[]): ScopedFragmentInput =>
  ({
    subject: { displayName: "Тестов Иван", aliases: [] },
    findings: [],
    surfaceUnits: [],
    metricSnapshot: { perRegionCounts: {} },
    scope: { regions: ["RU"], surfaces: ["ai_answers"], subjectMatch: null, findingIds: null },
    evidenceIndex: {},
    surfaceCollectionHints: hints,
  }) as unknown as ScopedFragmentInput;

const disabledTool = (engine: string): SurfaceCollectionHint => ({
  surface: "ai_answers",
  region: "RU",
  engine,
  status: "NOT_COLLECTED",
  provider: "arsenkin",
  errorCode: "DISABLED_BY_TOOLS",
});

const notConfigured: SurfaceCollectionHint = {
  surface: "ai_answers",
  region: "RU",
  engine: "YANDEX",
  status: "NOT_COLLECTED",
  provider: "yandex",
  errorCode: "PROVIDER_NOT_CONFIGURED",
};

describe("непригодный ключ — причина сильнее выключенного состава", () => {
  it("называется независимо от порядка ячеек", () => {
    for (const hints of [
      [disabledTool("YANDEX"), notConfigured],
      [notConfigured, disabledTool("YANDEX")],
    ]) {
      const status = resolveEmptySurfaceCollection(scoped(hints), "ai_answers");
      expect(status.kind).toBe("NOT_COLLECTED");
      expect(status.reasonLabel).toMatch(/не настроен/);
    }
  });

  it("в частичном состоянии причину по движку выбирает то же правило", () => {
    const status = resolveEmptySurfaceCollection(
      scoped([
        disabledTool("YANDEX"),
        notConfigured,
        {
          surface: "ai_answers",
          region: "RU",
          engine: "GOOGLE",
          status: "NO_RESULTS",
          provider: "GOOGLE",
          errorCode: null,
        },
      ]),
      "ai_answers"
    );
    expect(status.kind).toBe("MEASURED_PARTIAL");
    expect(status.notCollectedEngines).toEqual(["YANDEX"]);
    expect(status.reasonLabel).toMatch(/не настроен/);
  });

  it("без ячейки о ключе причина прежняя — выключенный состав", () => {
    const status = resolveEmptySurfaceCollection(
      scoped([disabledTool("YANDEX"), disabledTool("GOOGLE")]),
      "ai_answers"
    );
    expect(status.reasonLabel).toMatch(/не входил в состав прогона/);
  });
});
