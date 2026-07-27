import { describe, expect, it } from "vitest";
import { resolveRuntimeStrategy } from "../../src/modules/digital-profile/agents/runtime-strategy";
import { isPollAuthContentionOnly } from "../../src/modules/digital-profile/services/unified-orion-collection-orchestrator";

/**
 * Критерии приёмки шагов 01 и 03, которые были описаны, но не закреплены
 * тестом (docs/rework/01…, 03…).
 *
 * Оба дефекта уже исправлены, и оба умели тихо вернуться: подмена реальных
 * данных демо-агентом и внутренняя блокировка, засчитываемая как отказ
 * провайдера. Ни один из них не виден по симптому — виден только пустой или
 * шаблонный отчёт.
 *
 * Критерия 02 («лишний параметр запроса, выключающий модель целиком») здесь
 * больше нет. Он проверял `ai-analyst/openai-gpt55-analyst`, который к продукту
 * уже не подключён: живой путь к модели — `orion-golden/gpt/openai-json-client`
 * со своей реализацией `isReasoningModel`. Тест держал мёртвый модуль и этим
 * вводил в заблуждение — выглядел как страховка контракта модели, а страховал
 * код, который никто не вызывает. Модуль удалён вместе с ним; если контракт
 * тела запроса нужно закрепить, закреплять его следует на живом клиенте.
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
