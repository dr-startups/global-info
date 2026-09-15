import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/site/config/route";

/**
 * Статическая страница собирается без переменных окружения (образ в Docker их
 * не получает), поэтому то, что меняется без пересборки, — рубильник, ключ
 * виджета капчи, счётчик Метрики — она спрашивает у этой ручки. Ручка публичная,
 * и отдаёт она ровно три значения, которые и так увидит браузер; серверный ключ
 * капчи и прочие секреты сюда не попадают ни при каком окружении.
 */

const SECRETS = {
  SMARTCAPTCHA_SERVER_KEY: "ysc2_server-secret-value",
  DIGITAL_PROFILE_SESSION_SECRET: "session-secret-0123456789abcdef",
  OPENAI_API_KEY: "sk-openai-secret",
  SERPER_API_KEY: "serper-secret",
};

async function call() {
  const res = await GET();
  const raw = await res.text();
  return { res, raw, body: JSON.parse(raw) as { ok: boolean; data: Record<string, unknown> } };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/site/config", () => {
  it("ровно три публичных значения", async () => {
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
    vi.stubEnv("SMARTCAPTCHA_CLIENT_KEY", "ysc1_client-key");
    vi.stubEnv("YANDEX_METRIKA_ID", "12345678");
    const { res, raw, body } = await call();
    expect(res.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      data: { selfCheckEnabled: true, captchaClientKey: "ysc1_client-key", metrikaId: "12345678" },
    });
    for (const value of Object.values(SECRETS)) expect(raw).not.toContain(value);
  });

  it("пустые ключи — null, а не пустая строка: виджет и счётчик не подключаются", async () => {
    vi.stubEnv("SMARTCAPTCHA_CLIENT_KEY", "   ");
    vi.stubEnv("YANDEX_METRIKA_ID", "");
    const { body } = await call();
    expect(body.data).toEqual({ selfCheckEnabled: true, captchaClientKey: null, metrikaId: null });
  });

  it("выключенный рубильник ручка называет, а не отказывает: форме нужно знать, что прятать", async () => {
    vi.stubEnv("SELF_CHECK_ENABLED", "false");
    const { res, body } = await call();
    expect(res.status).toBe(200);
    expect(body.data.selfCheckEnabled).toBe(false);
  });

  it("не кэшируется и не индексируется", async () => {
    const { res } = await call();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });
});
