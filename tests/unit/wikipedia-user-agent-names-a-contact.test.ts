import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * User-Agent Википедии называет настоящий контакт.
 *
 * Правила Wikimedia требуют в User-Agent способ связи; с заглушкой
 * `admin@example.com` запросы ограничивают сильнее, а ответ 429 `fetchJson`
 * честно выжидает — кандидат в причины 20-секундных задержек панели «Это вы?»
 * (живые прогоны 23 и 24.09.2026). Контакт — решение владельца 24.09.2026.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function userAgent(): Promise<string> {
  vi.resetModules();
  const { providerConfig } = await import("@/modules/digital-profile/providers/config");
  return providerConfig.wikipedia.userAgent;
}

describe("User-Agent Википедии", () => {
  it("без переменной окружения называет контакт владельца, а не заглушку", async () => {
    vi.stubEnv("DIGITAL_PROFILE_WIKIPEDIA_USER_AGENT", "");
    const ua = await userAgent();
    expect(ua).toContain("anton.kovalenko10@mail.ru");
    expect(ua).not.toMatch(/example\.com/u);
  });

  it("переменная окружения по-прежнему заменяет значение", async () => {
    vi.stubEnv("DIGITAL_PROFILE_WIKIPEDIA_USER_AGENT", "Stand/1.0 (contact: stand@example.org)");
    expect(await userAgent()).toBe("Stand/1.0 (contact: stand@example.org)");
  });
});
