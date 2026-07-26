import { describe, expect, it } from "vitest";
import { resolveRuntimeStrategy } from "../../src/modules/digital-profile/agents/runtime-strategy";
import {
  chatCompletionRequestBody,
  isReasoningModel,
} from "../../src/modules/digital-profile/ai-analyst/openai-gpt55-analyst";
import { isPollAuthContentionOnly } from "../../src/modules/digital-profile/services/unified-orion-collection-orchestrator";

/**
 * Критерии приёмки шагов 01, 02 и 03, которые были описаны, но не закреплены
 * тестом (docs/rework/01…, 02…, 03…).
 *
 * Каждый из трёх дефектов уже исправлен, и каждый умел тихо вернуться: подмена
 * реальных данных демо-агентом, лишний параметр запроса, выключающий модель
 * целиком, и внутренняя блокировка, засчитываемая как отказ провайдера. Ни один
 * из них не виден по симптому — виден только пустой или шаблонный отчёт.
 */

describe("01. режим real_only не подпускает демо-агентов", () => {
  // Худший случай для проверки: демо-агенты доступны, реальные — нет. Именно
  // здесь прежний код и подставлял синтетику.
  const allMockAvailable: Record<string, boolean> = {
    YANDEX_SEARCH: true,
    GOOGLE_SEARCH: true,
    WIKIPEDIA: true,
    REAL_YANDEX_SEARCH: false,
    REAL_GOOGLE_SEARCH: false,
    REAL_WIKIPEDIA: false,
  };
  const strategy = resolveRuntimeStrategy({
    mode: "real_only",
    availabilityOverride: allMockAvailable,
  });

  it("ни одно выбранное исполнение не является демо", () => {
    // Подмена реальной выдачи синтетикой в документе о реальном человеке —
    // это не деградация качества, а ложь, и запрещена независимо от того,
    // насколько пустым выглядит отчёт без неё.
    const mockRuntimes = strategy.decisions.filter(
      (d) => d.status === "selected" && d.selectedRuntime === "mock"
    );
    expect(mockRuntimes).toEqual([]);
  });

  it("провайдер без реальной реализации пропускается, а не заменяется", () => {
    const skipped = strategy.decisions.filter((d) => d.status !== "selected");
    for (const d of skipped) {
      expect(d.reason).not.toMatch(/mock agent selected|fallback to mock/iu);
    }
  });

  it("проверка ловит именно real_only, а не запрет демо вообще", () => {
    // Иначе тесты выше зелены просто потому, что демо-агентов нет в сборке.
    const mockOnly = resolveRuntimeStrategy({
      mode: "mock_only",
      availabilityOverride: allMockAvailable,
    });
    expect(mockOnly.decisions.some((d) => d.status === "selected" && d.selectedRuntime === "mock")).toBe(
      true
    );
  });
});

describe("02. тело запроса соответствует контракту модели", () => {
  const body = (model: string) =>
    chatCompletionRequestBody({
      model,
      maxOutputTokens: 4000,
      systemPrompt: "s",
      userPrompt: "u",
    });

  it("gpt-5.5 получает запрос без temperature", () => {
    // Именно этот параметр давал HTTP 400 на каждом вызове, а слой считал 400
    // постоянным отказом и молча писал шаблон вместо анализа.
    expect(body("gpt-5.5")).not.toHaveProperty("temperature");
    expect(body("gpt-5-mini")).not.toHaveProperty("temperature");
    expect(body("o3-mini")).not.toHaveProperty("temperature");
  });

  it("gpt-4o получает temperature", () => {
    expect(body("gpt-4o")).toMatchObject({ temperature: 0.1 });
  });

  it("остальное тело одинаково для обеих семей", () => {
    for (const model of ["gpt-5.5", "gpt-4o"]) {
      expect(body(model)).toMatchObject({
        model,
        max_completion_tokens: 4000,
        response_format: { type: "json_object" },
      });
    }
  });

  it("семейства моделей распознаются по префиксу, а не по точному имени", () => {
    expect(isReasoningModel("GPT-5.5")).toBe(true);
    expect(isReasoningModel(" o1-preview ")).toBe(true);
    expect(isReasoningModel("gpt-4o-mini")).toBe(false);
  });
});

describe("03. внутренняя блокировка опроса не считается отказом провайдера", () => {
  const BLOCKED = "ARSENKIN_POLL_AUTH_BLOCKED: nested /set session";

  it("тик, состоящий только из блокировок, провайдера не трогал", () => {
    expect(isPollAuthContentionOnly([BLOCKED])).toBe(true);
    expect(isPollAuthContentionOnly([BLOCKED, BLOCKED])).toBe(true);
  });

  it("смешанный набор — блокировка и настоящая ошибка — даёт false", () => {
    // Критерий приёмки шага 03: одна реальная ошибка означает, что тик всё же
    // работал с провайдером, и списывать попытку обязательно.
    expect(isPollAuthContentionOnly([BLOCKED, "ARSENKIN_POLL_TIMEOUT: task 42"])).toBe(false);
    expect(isPollAuthContentionOnly([BLOCKED, "httpStatus:503"])).toBe(false);
  });

  it("пустой набор предупреждений блокировкой не считается", () => {
    expect(isPollAuthContentionOnly([])).toBe(false);
  });

  it("посторонние предупреждения решения не меняют", () => {
    expect(isPollAuthContentionOnly([BLOCKED, "offline-enrichment-mode"])).toBe(true);
  });
});
