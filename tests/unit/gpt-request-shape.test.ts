/**
 * Форма запроса к модели: кэш, усилие и тариф — из таблицы стадий (шаг 0123).
 *
 * Измерено на живых прогонах 20.09.2026: из 87 790 токенов входа 84 940
 * оплачены как запись кэша (1,25× обычного входа), а прочитано из кэша ноль —
 * точку разрыва ставил провайдер, и она приходилась на конец промпта. Тариф не
 * выбирался вовсе, хотя у чтения он может быть вдвое дешевле. Усилие
 * рассуждения стояло одно на двенадцати стадиях.
 */

import { describe, expect, it } from "vitest";
import {
  effortForStage,
  serviceTierForStage,
} from "@/modules/digital-profile/config/defaults";
import { callOpenAiStrictJsonOnce } from "@/modules/digital-profile/orion-golden/gpt/openai-json-client";

type Body = Record<string, any>;

function capture(
  bodies: Body[],
  opts: { failFirstWith?: number; recordTimeouts?: number[] } = {}
): typeof fetch {
  let n = 0;
  return (async (_url: unknown, init?: { body?: string; signal?: AbortSignal }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Body;
    bodies.push(body);
    n += 1;
    if (opts.failFirstWith && n === 1) {
      return { ok: false, status: opts.failFirstWith, headers: new Headers() };
    }
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

describe("кэш промпта", () => {
  it("К1: точка кэша стоит на системном блоке, неявная выключена", async () => {
    const bodies: Body[] = [];
    await callOpenAiStrictJsonOnce({
      stage: "link_verdict",
      systemPrompt: "инструкция",
      userPayload: { page: "текст" },
      fetchImpl: capture(bodies),
    });
    const body = bodies[0]!;
    expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    const [system, user] = body.input as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(system!.role).toBe("system");
    expect(system!.content[0]!.prompt_cache_breakpoint).toEqual({ mode: "explicit" });
    // Динамическая часть в кэш не пишется — иначе наценка вернётся.
    expect(user!.content[0]!.prompt_cache_breakpoint).toBeUndefined();
  });
});

describe("усилие рассуждения по стадиям", () => {
  it("К2: текст клиента — medium, извлечение и чтение — low", async () => {
    expect(effortForStage("slide_copy")).toBe("medium");
    expect(effortForStage("case_analysis")).toBe("medium");
    expect(effortForStage("link_verdict")).toBe("low");
    expect(effortForStage("fact_extraction")).toBe("low");

    const bodies: Body[] = [];
    await callOpenAiStrictJsonOnce({
      stage: "slide_copy",
      systemPrompt: "s",
      userPayload: {},
      fetchImpl: capture(bodies),
    });
    expect(bodies[0]!.reasoning).toEqual({ effort: "medium" });
  });
});

describe("тариф", () => {
  it("К3: чтение уходит медленным тарифом, текст слайдов — обычным", async () => {
    expect(serviceTierForStage("link_verdict")).toBe("flex");
    expect(serviceTierForStage("slide_copy")).toBeUndefined();

    const reading: Body[] = [];
    await callOpenAiStrictJsonOnce({
      stage: "link_verdict",
      systemPrompt: "s",
      userPayload: {},
      fetchImpl: capture(reading),
    });
    expect(reading[0]!.service_tier).toBe("flex");

    const copy: Body[] = [];
    await callOpenAiStrictJsonOnce({
      stage: "slide_copy",
      systemPrompt: "s",
      userPayload: {},
      fetchImpl: capture(copy),
    });
    expect(copy[0]!.service_tier).toBeUndefined();
  });

  it("К4: «нет ёмкости» на медленном тарифе повторяется обычным, вызов не падает", async () => {
    const bodies: Body[] = [];
    const parsed = await callOpenAiStrictJsonOnce({
      stage: "link_verdict",
      systemPrompt: "s",
      userPayload: {},
      fetchImpl: capture(bodies, { failFirstWith: 429 }),
    });
    expect(parsed).toEqual({ ok: true });
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.service_tier).toBe("flex");
    expect(bodies[1]!.service_tier).toBeUndefined();
  });
});
