/**
 * Пустая поверхность Topvisor называет настоящую причину.
 *
 * Отчёт 83, стр. 74 «ОАЭ — подсказки поиска»: «инструмент сбора не входил в
 * состав прогона», хотя Topvisor вызывался и вернул ноль строк
 * (`collect: google-dubai total 0`). А по Google-Москве провайдер подсказки
 * не собирает вовсе — это «не поддерживается», а не «не спрашивали».
 * О состоянии Topvisor дека узнаёт ячейками покрытия — тем же каналом, что
 * о выключенных агентах Arsenkin и о пробе нейро-ответа.
 */

import { describe, expect, it } from "vitest";
import {
  topvisorCoverageCells,
  type TopvisorEnrichmentState,
} from "@/modules/digital-profile/services/topvisor-positions-tick";
import {
  resolveEmptySurfaceCollection,
  type SurfaceCollectionHint,
} from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import { coverageContent } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

function doneState(over: Partial<TopvisorEnrichmentState> = {}): TopvisorEnrichmentState {
  return {
    version: 1,
    phase: "DONE",
    projectId: 1,
    reportRunId: "topvisor-positions-job-1",
    providerTaskId: "pt-1",
    externalTaskId: "1:2026-09-03",
    checkDate: "2026-09-03",
    regions: [
      { key: "yandex-moscow", index: 1, engine: "YANDEX", region: "RU", rows: 260 },
      { key: "google-moscow", index: 2, engine: "GOOGLE", region: "RU", rows: 221 },
      { key: "google-dubai", index: 2520, engine: "GOOGLE", region: "UAE", rows: 0 },
    ],
    keywords: 21,
    lastPercent: 100,
    observationCount: 481,
    aiAnswerCount: 3,
    aiAbsentQueries: [],
    suggest: [
      { key: "yandex-moscow", sourceQuery: "Кремлёв Умар Назарович", groupId: 74625442, ready: true, rows: 45 },
      { key: "google-moscow", sourceQuery: "Кремлёв Умар Назарович", groupId: null, ready: true, rows: 0 },
      { key: "google-dubai", sourceQuery: "Kremlev Umar Nazarovich", groupId: 74625443, ready: true, rows: 0 },
    ],
    suggestionCount: 45,
    errorCode: null,
    errorMessage: null,
    updatedAt: "2026-09-03T12:56:43.000Z",
    ...over,
  } as TopvisorEnrichmentState;
}

function hintsOf(state: unknown): SurfaceCollectionHint[] {
  return topvisorCoverageCells(state).map((c) => ({
    surface: c.surface,
    region: c.region,
    engine: c.engine,
    status: c.status,
    errorCode: c.errorCode ?? null,
    provider: c.provider,
  }));
}

describe("ячейки покрытия Topvisor", () => {
  it("ноль подсказок из готовой группы — измеренная пустота, отказ провайдера — «не поддерживается»", () => {
    const cells = topvisorCoverageCells(doneState());
    expect(cells).toContainEqual(
      expect.objectContaining({ region: "UAE", engine: "GOOGLE", surface: "suggestions", status: "NO_RESULTS", provider: "topvisor" })
    );
    expect(cells).toContainEqual(
      expect.objectContaining({ region: "RU", engine: "GOOGLE", surface: "suggestions", status: "NOT_COLLECTED", errorCode: "TOPVISOR_NOT_SUPPORTED" })
    );
    // Собранные строки о себе говорят сами: ячейки на них нет.
    expect(cells.find((c) => c.region === "RU" && c.engine === "YANDEX" && c.surface === "suggestions")).toBeUndefined();
    // Органика Дубая пуста после проверки — тоже измеренная пустота.
    expect(cells).toContainEqual(
      expect.objectContaining({ region: "UAE", engine: "GOOGLE", surface: "organic", status: "NO_RESULTS" })
    );
  });

  it("AI-ответ по ФИО, которого поисковик не показал, — измеренная пустота", () => {
    // Прогон DPA-2026-0051: Google AI Overview по запросу ФИО не показан ни в
    // Москве, ни в Дубае (`aiAbsentQueries`), Алиса ответила. Без ячейки
    // страница молчит о том, что вопрос задавался.
    const cells = topvisorCoverageCells(
      doneState({ aiAbsentQueries: ["google-moscow:Кремлев Умар Назарович", "google-dubai:Kremlev Umar Nazarovich"] })
    );
    expect(cells).toContainEqual(
      expect.objectContaining({ region: "RU", engine: "GOOGLE", surface: "ai_answers", status: "NO_RESULTS", provider: "topvisor" })
    );
    expect(cells).toContainEqual(
      expect.objectContaining({ region: "UAE", engine: "GOOGLE", surface: "ai_answers", status: "NO_RESULTS", provider: "topvisor" })
    );
    expect(cells.find((c) => c.surface === "ai_answers" && c.engine === "YANDEX")).toBeUndefined();
  });

  it("незавершённый прогон ячеек не даёт: пустота не измерена", () => {
    expect(topvisorCoverageCells(doneState({ phase: "COLLECTING" }))).toEqual([]);
    expect(topvisorCoverageCells(null)).toEqual([]);
  });
});

describe("страница пустой поверхности", () => {
  const scoped = (regions: string[], hints: SurfaceCollectionHint[]) =>
    ({ surfaceUnits: [], scope: { regions }, surfaceCollectionHints: hints }) as unknown as Parameters<
      typeof resolveEmptySurfaceCollection
    >[0];

  it("ОАЭ — подсказки: «проверено, пусто», а не «инструмент не входил в прогон»", () => {
    const status = resolveEmptySurfaceCollection(scoped(["UAE"], hintsOf(doneState())), "suggestions");
    expect(status.kind).toBe("MEASURED_EMPTY");
    const body = coverageContent("suggestions", status, "ОАЭ");
    expect(body.narrative ?? "").not.toMatch(/не входил в состав прогона/);
  });

  it("Россия — подсказки Google: причина — провайдер не собирает поверхность для региона", () => {
    const hints = hintsOf(doneState()).filter((h) => h.region === "RU");
    const status = resolveEmptySurfaceCollection(scoped(["RU"], hints), "suggestions");
    // Яндекс измерен строками (ячейки нет), Google не поддержан: частичное состояние.
    expect(status.kind).toBe("NOT_COLLECTED");
    expect(status.reasonLabel ?? "").toMatch(/провайдер не собирает/);
  });
});
