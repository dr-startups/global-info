/**
 * За глубину платят там, где она доезжает до отчёта.
 *
 * Батч поверхностей зовёт `/search` не ради органики: её строки вызывающий тут
 * же выбрасывает (`runRegionSurfaces` пропускает `kind === "organic"`), а нужны
 * из ответа только связанные запросы и карточка знания. При этом батч просил у
 * Serper глубину аудита — `num` больше десяти, то есть два кредита за запрос
 * вместо одного, — и каждый регион платил вдвое за строки, которых никто не
 * увидит.
 *
 * Картинки и видео так же не станут глубже: их лимит трогать нельзя, там глубина
 * доезжает до страниц изображений и видео.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Тела запросов по конечным точкам Serper; сеть подменена целиком. */
function captureSerperCalls(): Map<string, Record<string, unknown>> {
  const byEndpoint = new Map<string, Record<string, unknown>>();
  globalThis.fetch = (async (url: string, init: { body?: string }) => {
    byEndpoint.set(String(url), JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return {
      status: 200,
      ok: true,
      text: async () => JSON.stringify({ organic: [], images: [], videos: [] }),
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return byEndpoint;
}

describe("батч поверхностей не платит за выброшенную органику", () => {
  it("органика батча идёт на умолчании провайдера, картинки и видео — на глубине аудита", async () => {
    vi.stubEnv("GOOGLE_EXTERNAL_SERP_API_KEY", "offline-test-key");
    vi.stubEnv("GOOGLE_EXTERNAL_SERP_PROVIDER", "serper");
    vi.resetModules();
    const calls = captureSerperCalls();
    const { serperAllSurfacesForQuery } = await import(
      "@/modules/digital-profile/providers/serper-surfaces"
    );
    await serperAllSurfacesForQuery(
      {
        caseId: "case-surfaces",
        subjectFullName: "Виктор Рашников",
        aliases: [],
        query: "виктор рашников",
        language: "ru",
      },
      "RU",
      20
    );
    // Глубина у органики батча не просится вовсе: `num` в теле отсутствует.
    expect(calls.get("https://google.serper.dev/search")).not.toHaveProperty("num");
    expect(calls.get("https://google.serper.dev/images")?.num).toBe(20);
    expect(calls.get("https://google.serper.dev/videos")?.num).toBe(20);
  });
});
