import { describe, expect, it } from "vitest";
import { runSurfaceAnalyzers } from "@/modules/digital-profile/orion-golden/analytics/surface-analyzers";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

/**
 * Шаг AO, доводка. «Это пометка о пустоте или материал?» — вопрос, на который
 * данные отвечают точно: сборщик пишет вид строки (`answer_text` / `absent` /
 * `answer_rejected`), и гадать по длине текста там незачем.
 *
 * Окно оставалось открытым: короткий настоящий ответ-отрицание анализатор
 * считал маркером, а дека печатала его с подписью — шапка «Показано 0
 * результатов» над напечатанным ответом достижима на 116 знаках.
 */

function item(partial: Partial<RawInventoryItem> & { inventoryId: string }): RawInventoryItem {
  return {
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-08-20T00:00:00.000Z",
    evidenceType: "ai_answer",
    title: "Нейро-ответ Яндекса (официальный API): Тестов Иван",
    snippet: "",
    rawMetadata: { engine: "YANDEX", surface: "ai_answer" },
    ...partial,
  } as RawInventoryItem;
}

function unitOf(items: RawInventoryItem[]) {
  return runSurfaceAnalyzers({
    caseId: "case-1",
    datasetId: "d-1",
    items,
    resolutionLookup: new Map(),
    sourceHashes: [],
  }).ai_answers.units[0];
}

const metric = (u: ReturnType<typeof unitOf>, key: string) =>
  u!.metrics.find((m) => m.key === key)?.value;

/** Настоящий короткий ответ, целиком состоящий из отрицания. */
const SHORT_NEGATIVE_ANSWER =
  "Сведений о судимости в открытых источниках не найдено; он указан как основатель Nordkap Capital.";

describe("вид строки решает, маркер это или материал", () => {
  it("короткий ответ-отрицание с видом answer_text остаётся материалом", () => {
    const u = unitOf([
      item({
        inventoryId: "obs-short",
        snippet: SHORT_NEGATIVE_ANSWER,
        rawMetadata: { engine: "YANDEX", surface: "ai_answer", contentKind: "answer_text" },
      }),
    ]);
    expect(metric(u, "totalCount")).toBe(1);
    expect(metric(u, "emptyMarkerCount")).toBe(0);
  });

  it("вид absent делает маркером даже нейтральный на вид текст", () => {
    const u = unitOf([
      item({
        inventoryId: "obs-absent",
        title: "Нейро-ответ Яндекса",
        snippet: "Запрос поисковику отправлен, генеративного ответа по нему нет.",
        rawMetadata: { engine: "YANDEX", surface: "ai_answer", contentKind: "absent" },
      }),
    ]);
    expect(metric(u, "emptyMarkerCount")).toBe(1);
    expect(metric(u, "totalCount")).toBe(0);
  });

  it("вид answer_rejected — тоже измеренная пустота", () => {
    const u = unitOf([
      item({
        inventoryId: "obs-rejected",
        title: "Нейро-ответ Яндекса",
        snippet: "Сработали этические ограничения модели.",
        rawMetadata: { engine: "YANDEX", surface: "ai_answer", contentKind: "answer_rejected" },
      }),
    ]);
    expect(metric(u, "emptyMarkerCount")).toBe(1);
  });

  it("вид answer_source материалом и остаётся", () => {
    const u = unitOf([
      item({
        inventoryId: "obs-src",
        title: "Профиль предпринимателя — источник ответа",
        snippet: "Материалов о судимости не найдено.",
        rawMetadata: { engine: "YANDEX", surface: "ai_answer", contentKind: "answer_source" },
      }),
    ]);
    expect(metric(u, "totalCount")).toBe(1);
    expect(metric(u, "emptyMarkerCount")).toBe(0);
  });

  it("строка без вида по-прежнему опознаётся по словам — фолбэк не снят", () => {
    const byTitle = unitOf([
      item({ inventoryId: "obs-a", title: "ИИ-ответ (Алиса): не найден", snippet: "Блока нет." }),
    ]);
    expect(metric(byTitle, "emptyMarkerCount")).toBe(1);

    const bySnippet = unitOf([
      item({
        inventoryId: "obs-b",
        source: "wikipedia_check",
        evidenceType: "ai_answer",
        title: "Wikipedia",
        snippet: "Фактическая проверка Wikipedia: статья не найдена.",
        rawMetadata: { engine: "YANDEX", surface: "ai_answer" },
      }),
    ]);
    expect(metric(bySnippet, "emptyMarkerCount")).toBe(1);
  });
});
