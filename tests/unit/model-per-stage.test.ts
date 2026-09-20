/**
 * Модель выбирается под стадию, а не одна на весь конвейер (шаг 0119).
 *
 * До этого шага модель задавалась переменной окружения
 * `DIGITAL_PROFILE_AI_ANALYST_MODEL` с умолчанием `gpt-5.5` и была одна на
 * двенадцать разных стадий: и на чтение страницы, где ответ структурный и код
 * сверяет каждую цитату, и на композицию деки, где модель пишет текст клиенту.
 * Стадии отличаются и по цене входа, и по цене ошибки.
 *
 * Правило: таблица «стадия → модель» одна и лежит среди несекретных настроек;
 * стадия называется в самом вызове, и вызов без неё не компилируется.
 */

import { describe, expect, it } from "vitest";
import {
  GPT_MODEL_PRICES,
  GPT_STAGE_MODELS,
  GPT_STAGES,
  modelForStage,
  priceForModel,
} from "@/modules/digital-profile/config/defaults";
import { callOpenAiStrictJsonOnce } from "@/modules/digital-profile/orion-golden/gpt/openai-json-client";

/** Ответ API, которого хватает клиенту: разобранный JSON и счёт токенов. */
function fakeFetch(bodies: Array<Record<string, unknown>>): typeof fetch {
  return (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "completed",
        usage: { input_tokens: 100, output_tokens: 10 },
        output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }],
      }),
    };
  }) as unknown as typeof fetch;
}

describe("таблица «стадия → модель»", () => {
  it("М1: клиентский текст — Sol, извлечение — Terra, подсказки тем — Luna", () => {
    for (const stage of [
      "case_analysis",
      "executive_summary",
      "deck_compose",
      "deck_edit",
      "slide_copy",
    ] as const) {
      expect(modelForStage(stage), stage).toBe("gpt-5.6-sol");
    }
    // Чтение страниц и разбор статьи Википедии переехали на Sol (шаг 0120) —
    // их держит М5, здесь остались стадии короткого извлечения.
    for (const stage of ["fact_extraction", "theme_clustering", "identity", "auto_analyst"] as const) {
      expect(modelForStage(stage), stage).toBe("gpt-5.6-terra");
    }
    expect(modelForStage("theme_suggestion")).toBe("gpt-5.6-luna");
  });

  it("М5: дословная цитата длинной страницы — на Sol, короткое извлечение — на Terra", () => {
    // Измерено на живых прогонах 20.09.2026: аудит снял 11–26 % цитат Terra
    // против 0,7–2,5 % у прежней модели, у разбора статьи Википедии — 3 и 4
    // выдуманных фрагмента против нуля. Там, где вход короткий и цитату
    // проверяет код, Terra держится: извлечение фактов отбросило 0–2 против 1.
    expect(modelForStage("link_verdict")).toBe("gpt-5.6-sol");
    expect(modelForStage("wikipedia_review")).toBe("gpt-5.6-sol");
    for (const stage of ["fact_extraction", "theme_clustering", "identity", "auto_analyst"] as const) {
      expect(modelForStage(stage), stage).toBe("gpt-5.6-terra");
    }
  });

  it("М2: у каждой стадии есть строка таблицы, у каждой модели — цена", () => {
    for (const stage of GPT_STAGES) {
      const row = GPT_STAGE_MODELS[stage];
      expect(row?.model, stage).toBeTruthy();
      // Русское название стадии печатается в артефакте учёта: его читает владелец.
      expect(row?.label, stage).toBeTruthy();
      // Без цены учёт молча посчитал бы стадию бесплатной.
      expect(priceForModel(row.model), `${stage} → ${row.model}`).toBeTruthy();
    }
    for (const model of Object.keys(GPT_MODEL_PRICES)) {
      const price = GPT_MODEL_PRICES[model]!;
      expect(price.input, model).toBeGreaterThan(0);
      expect(price.output, model).toBeGreaterThan(0);
      // Кэшированный вход дешевле обычного — иначе это не кэш, а опечатка.
      expect(price.cachedInput, model).toBeLessThan(price.input);
    }
  });

  it("М3: запрос уходит с моделью своей стадии", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = fakeFetch(bodies);
    await callOpenAiStrictJsonOnce({
      stage: "fact_extraction",
      systemPrompt: "s",
      userPayload: { a: 1 },
      fetchImpl,
    });
    await callOpenAiStrictJsonOnce({
      stage: "slide_copy",
      systemPrompt: "s",
      userPayload: { a: 1 },
      fetchImpl,
    });
    expect(bodies.map((b) => b.model)).toEqual(["gpt-5.6-terra", "gpt-5.6-sol"]);
  });

  it("М4: у новой линейки едет усилие рассуждения low", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    await callOpenAiStrictJsonOnce({
      stage: "link_verdict",
      systemPrompt: "s",
      userPayload: { a: 1 },
      fetchImpl: fakeFetch(bodies),
    });
    expect(bodies[0]!.reasoning).toEqual({ effort: "low" });
  });
});
