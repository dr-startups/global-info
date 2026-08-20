import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Шаг AO. Нейро-ответ не заводит собственных переменных окружения: разрешение —
 * тот же ключ и каталог, что у органики. Без них вызова не происходит вовсе,
 * а причина называется словами — иначе оператор узнаёт о непригодном ключе
 * из пустого отчёта, то есть после потраченного прогона.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.resetModules();
});

/** Шпион: любой вызов сети здесь — уже провал. */
function refuseNetwork(): { calls: number } {
  const state = { calls: 0 };
  globalThis.fetch = (async () => {
    state.calls += 1;
    throw new Error("сеть в офлайн-контуре не вызывается");
  }) as typeof globalThis.fetch;
  return state;
}

describe("разрешение на нейро-ответ — ключ, а не флаг", () => {
  it("без ключа и каталога — NOT_CONFIGURED и ни одного вызова fetch", async () => {
    vi.stubEnv("YANDEX_SEARCH_API_KEY", "");
    vi.stubEnv("YANDEX_SEARCH_FOLDER_ID", "");
    vi.resetModules();
    const spy = refuseNetwork();
    const { fetchYandexGenAnswer } = await import(
      "@/modules/digital-profile/providers/yandex-search-provider"
    );
    const out = await fetchYandexGenAnswer("Мордашов Алексей Александрович");
    expect(spy.calls).toBe(0);
    if (out.status !== "NOT_CONFIGURED") throw new Error(`ожидался NOT_CONFIGURED, получен ${out.status}`);
    expect(out.message).toMatch(/YANDEX_SEARCH_API_KEY/);
    expect(out.message).toMatch(/YANDEX_SEARCH_FOLDER_ID/);
  });

  it("оставшаяся заглушка ключом не считается — тоже NOT_CONFIGURED без вызова", async () => {
    vi.stubEnv("YANDEX_SEARCH_API_KEY", "<<<FILL>>>");
    vi.stubEnv("YANDEX_SEARCH_FOLDER_ID", "b1goffline0000test");
    vi.resetModules();
    const spy = refuseNetwork();
    const { fetchYandexGenAnswer } = await import(
      "@/modules/digital-profile/providers/yandex-search-provider"
    );
    const out = await fetchYandexGenAnswer("Мордашов Алексей Александрович");
    expect(spy.calls).toBe(0);
    if (out.status !== "NOT_CONFIGURED") throw new Error(`ожидался NOT_CONFIGURED, получен ${out.status}`);
    expect(out.message).toMatch(/YANDEX_SEARCH_API_KEY/);
  });
});

describe("настроенный провайдер спрашивает официальный эндпойнт", () => {
  it("ключ уходит только заголовком, тело — контракт GenSearch", async () => {
    vi.stubEnv("YANDEX_SEARCH_API_KEY", "AQVNoffline0000testkey1234567890abcd");
    vi.stubEnv("YANDEX_SEARCH_FOLDER_ID", "b1goffline0000test");
    vi.resetModules();
    let seenUrl = "";
    let seenBody = "";
    let seenHeaders: Record<string, string> = {};
    globalThis.fetch = (async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      seenUrl = String(url);
      seenBody = String(init?.body ?? "");
      seenHeaders = init?.headers ?? {};
      return {
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            message: { content: "Ответ." },
            sources: [{ url: "https://forbes.ru/a", title: "Forbes", used: true }],
          }),
      } as unknown as Response;
    }) as typeof globalThis.fetch;
    const { fetchYandexGenAnswer } = await import(
      "@/modules/digital-profile/providers/yandex-search-provider"
    );
    const out = await fetchYandexGenAnswer("Мордашов Алексей Александрович");
    expect(out.status).toBe("SUCCESS");
    expect(seenUrl).toBe("https://searchapi.api.cloud.yandex.net/v2/gen/search");
    expect(seenUrl).not.toMatch(/AQVN/);
    expect(seenHeaders.Authorization).toBe("Api-Key AQVNoffline0000testkey1234567890abcd");
    const body = JSON.parse(seenBody) as Record<string, unknown>;
    expect(body.folderId).toBe("b1goffline0000test");
    expect(body.messages).toEqual([
      { role: "ROLE_USER", content: "Мордашов Алексей Александрович" },
    ]);
  });

  it("контур вопроса — всегда российский, как бы ни был настроен регион органики", async () => {
    // Наблюдение жёстко приписывается RU, поэтому и вопрос обязан уходить в
    // российский индекс: иначе отчёт называет турецкую выдачу российской.
    vi.stubEnv("YANDEX_SEARCH_API_KEY", "AQVNoffline0000testkey1234567890abcd");
    vi.stubEnv("YANDEX_SEARCH_FOLDER_ID", "b1goffline0000test");
    vi.stubEnv("YANDEX_SEARCH_REGION", "tr");
    vi.resetModules();
    let seenBody = "";
    globalThis.fetch = (async (_url: string, init: { body?: string }) => {
      seenBody = String(init?.body ?? "");
      return {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ message: { content: "Ответ." } }),
      } as unknown as Response;
    }) as typeof globalThis.fetch;
    const { fetchYandexGenAnswer } = await import(
      "@/modules/digital-profile/providers/yandex-search-provider"
    );
    await fetchYandexGenAnswer("Мордашов Алексей Александрович");
    expect(JSON.parse(seenBody).searchType).toBe("SEARCH_TYPE_RU");
  });

  it("отказ модели различается от пустого ответа и от сбоя", async () => {
    vi.stubEnv("YANDEX_SEARCH_API_KEY", "AQVNoffline0000testkey1234567890abcd");
    vi.stubEnv("YANDEX_SEARCH_FOLDER_ID", "b1goffline0000test");
    vi.resetModules();
    const reply = (payload: unknown, status = 200) =>
      (globalThis.fetch = (async () =>
        ({
          status,
          ok: status < 400,
          text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
        }) as unknown as Response) as typeof globalThis.fetch);
    const { fetchYandexGenAnswer } = await import(
      "@/modules/digital-profile/providers/yandex-search-provider"
    );

    reply({ message: { content: "" }, is_answer_rejected: true });
    expect((await fetchYandexGenAnswer("q")).status).toBe("REJECTED");

    reply({ message: { content: "  " }, sources: [] });
    expect((await fetchYandexGenAnswer("q")).status).toBe("NO_RESULTS");

    reply("Forbidden", 403);
    const failed = await fetchYandexGenAnswer("q");
    if (failed.status !== "FAILED") throw new Error(`ожидался FAILED, получен ${failed.status}`);
    expect(failed.errorCode).toBe("PROVIDER_BAD_RESPONSE");

    reply("<html>captcha</html>");
    const broken = await fetchYandexGenAnswer("q");
    if (broken.status !== "FAILED") throw new Error(`ожидался FAILED, получен ${broken.status}`);
    expect(broken.errorCode).toBe("PROVIDER_INVALID_RESPONSE");
  });
});
