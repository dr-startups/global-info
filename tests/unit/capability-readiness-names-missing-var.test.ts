import { describe, expect, it } from "vitest";
import {
  describeCapabilityReadiness,
  validateDigitalProfileEnv,
} from "../../src/modules/digital-profile/config/env-validation";
import { BOOLEAN_DEFAULTS, STRING_DEFAULTS } from "../../src/modules/digital-profile/config/defaults";

/**
 * В переменных окружения живут только секреты.
 *
 * На стенде молча отключились Google и ORION: ключ `SERPER_API_KEY` стоял, а
 * `GOOGLE_EXTERNAL_SERP_PROVIDER` — нет, и провайдер уходил в `NOT_SELECTED`.
 * Для агента это законный исход, поэтому в логе не было ничего, а в UI он
 * просто числился недоступным.
 *
 * Вывод не «дописать переменную в инструкцию», а «убрать переменную»: значения
 * по умолчанию в коде дают работающий продукт целиком. Это безопасно, потому
 * что разрешением служит ключ, а не флаг — без ключа провайдер не ходит в сеть.
 *
 * Здесь проверяется именно это свойство: **выключить сборщик может только
 * отсутствующий секрет**.
 */

/** Только секреты — ни одного флага. */
const SECRETS_ONLY: Record<string, string> = {
  ARSENKIN_API_TOKEN: "t0ken",
  SERPER_API_KEY: "serper-key",
  YANDEX_SEARCH_API_KEY: "ya-key",
  YANDEX_SEARCH_FOLDER_ID: "folder",
  OPENAI_API_KEY: "sk-test",
};

const readiness = (env: Record<string, string | undefined>) =>
  new Map(describeCapabilityReadiness(env).map((c) => [c.capability, c]));

describe("сводка готовности сборщиков", () => {
  /**
   * Единственное исключение из правила «в переменных живут только секреты».
   *
   * Чтение страниц открывает чужие сайты и гоняет их текст через модель — это
   * деньги за каждый отчёт. Такое не должно включаться само у всякого, кто
   * развернул продукт: решение о трате принимает человек. Исключение названо
   * здесь поимённо, чтобы оно не разрослось молча.
   */
  const PAID_OPT_IN = "Чтение страниц (разбор ссылок ТОП-20)";

  it("одних секретов достаточно: все сборщики готовы без единого флага", () => {
    for (const c of describeCapabilityReadiness(SECRETS_ONLY)) {
      if (c.capability === PAID_OPT_IN) continue;
      expect(c.ready, `${c.capability}: ${c.detail}`).toBe(true);
    }
  });

  it("чтение страниц выключено по умолчанию и говорит, чего не хватает", () => {
    const entry = readiness(SECRETS_ONLY).get(PAID_OPT_IN);
    expect(entry?.ready).toBe(false);
    expect(entry?.detail).toContain("DIGITAL_PROFILE_LINK_READING");
  });

  it("с разрешением и ключом чтение страниц готово", () => {
    const env = { ...SECRETS_ONLY, DIGITAL_PROFILE_LINK_READING: "true" };
    expect(readiness(env).get(PAID_OPT_IN)?.ready).toBe(true);
  });

  it.each([
    ["ARSENKIN_API_TOKEN", "Arsenkin (5 агентов обогащения)"],
    ["SERPER_API_KEY", "ORION Search Profile (поверхности Google)"],
    ["YANDEX_SEARCH_FOLDER_ID", "Yandex Search (Cloud Search API v2)"],
    ["OPENAI_API_KEY", "AI-аналитик (текст отчёта)"],
  ])("без секрета %s сборщик «%s» выключен и переменная названа", (secret, capability) => {
    const env = { ...SECRETS_ONLY };
    delete env[secret];
    const entry = readiness(env).get(capability);
    expect(entry?.ready).toBe(false);
    expect(entry?.detail).toContain(secret);
  });

  it("псевдоним GOOGLE_EXTERNAL_SERP_API_KEY равноправен с SERPER_API_KEY", () => {
    const env = { ...SECRETS_ONLY };
    delete env.SERPER_API_KEY;
    env.GOOGLE_EXTERNAL_SERP_API_KEY = "serper-key";
    expect(readiness(env).get("ORION Search Profile (поверхности Google)")?.ready).toBe(true);
  });

  it("флаг всё ещё может выключить сборщик вручную", () => {
    // Значения по умолчанию — не запрет: отключить источник по-прежнему можно,
    // это осознанное действие, а не забытая переменная.
    const off = readiness({ ...SECRETS_ONLY, ARSENKIN_ENABLED: "false" });
    expect(off.get("Arsenkin (5 агентов обогащения)")?.ready).toBe(false);
  });

  it("значения переменных в сводку не попадают", () => {
    const text = JSON.stringify(describeCapabilityReadiness(SECRETS_ONLY));
    for (const s of Object.values(SECRETS_ONLY)) expect(text).not.toContain(s);
  });
});

describe("значения по умолчанию описывают работающий продукт", () => {
  it("все источники включены, а демо-агенты — нет", () => {
    expect(BOOLEAN_DEFAULTS.DIGITAL_PROFILE_ENABLED).toBe(true);
    expect(BOOLEAN_DEFAULTS.DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED).toBe(true);
    expect(BOOLEAN_DEFAULTS.DIGITAL_PROFILE_GOOGLE_REAL_ENABLED).toBe(true);
    expect(BOOLEAN_DEFAULTS.DIGITAL_PROFILE_YANDEX_REAL_ENABLED).toBe(true);
    expect(BOOLEAN_DEFAULTS.ARSENKIN_ENABLED).toBe(true);
    expect(BOOLEAN_DEFAULTS.DIGITAL_PROFILE_AI_ANALYST_ENABLED).toBe(true);
    // Демо-агенты на реальном кейсе недопустимы.
    expect(BOOLEAN_DEFAULTS.DIGITAL_PROFILE_MOCK_AGENTS).toBe(false);
    // Незакрытая админка — открытый доступ к делам клиентов.
    expect(BOOLEAN_DEFAULTS.DIGITAL_PROFILE_AUTH_ENABLED).toBe(true);
  });

  it("источник выдачи Google выбран заранее", () => {
    expect(STRING_DEFAULTS.GOOGLE_SEARCH_PROVIDER).toBe("external_serp");
    expect(STRING_DEFAULTS.GOOGLE_EXTERNAL_SERP_PROVIDER).toBe("serper");
  });
});

describe("проверка окружения знает про Arsenkin", () => {
  const BASE = {
    DATABASE_URL: "postgres://x",
    DIGITAL_PROFILE_SIGNED_URL_SECRET: "0123456789abcdefgh",
    DIGITAL_PROFILE_SESSION_SECRET: "0123456789abcdefgh",
  };

  it("включённый Arsenkin без токена — критическая ошибка", () => {
    // Флага нет, но по умолчанию он включён: значит токен обязателен.
    const { errors } = validateDigitalProfileEnv({ ...BASE });
    expect(errors.join("\n")).toContain("ARSENKIN_API_TOKEN");
  });

  it("осознанно выключенный Arsenkin — предупреждение о неполном отчёте", () => {
    const { warnings } = validateDigitalProfileEnv({ ...BASE, ARSENKIN_ENABLED: "false" });
    expect(warnings.join("\n")).toContain("ARSENKIN_ENABLED");
  });
});
