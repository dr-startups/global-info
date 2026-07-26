import { describe, expect, it } from "vitest";
import {
  describeCapabilityReadiness,
  validateDigitalProfileEnv,
} from "../../src/modules/digital-profile/config/env-validation";

/**
 * Выключенный сборщик обязан называть недостающую переменную.
 *
 * На стенде молча отключились Google и ORION. Для самого агента отсутствие
 * ключа — законный исход (`NOT_CONFIGURED`), поэтому в логе не было ничего, а
 * в UI агент просто числился недоступным. Включение при этом собрано из
 * цепочки: у ORION её звеньев пять, и пропуск любого даёт один и тот же
 * молчаливый результат.
 *
 * Отдельная история — Arsenkin: проверки окружения для него не было вовсе, при
 * том что интеграция платная.
 */

const READY_ENV: Record<string, string> = {
  ARSENKIN_ENABLED: "true",
  ARSENKIN_API_TOKEN: "t0ken",
  GOOGLE_EXTERNAL_SERP_PROVIDER: "serper",
  GOOGLE_EXTERNAL_SERP_API_KEY: "serper-key",
  DIGITAL_PROFILE_GOOGLE_REAL_ENABLED: "true",
  GOOGLE_SEARCH_PROVIDER: "external_serp",
  DIGITAL_PROFILE_YANDEX_REAL_ENABLED: "true",
  YANDEX_SEARCH_API_KEY: "ya-key",
  YANDEX_SEARCH_FOLDER_ID: "folder",
  DIGITAL_PROFILE_AI_ANALYST_ENABLED: "true",
  OPENAI_API_KEY: "sk-test",
  RENDERER_URL: "http://renderer:8080",
};

const readiness = (env: Record<string, string | undefined>) =>
  new Map(describeCapabilityReadiness(env).map((c) => [c.capability, c]));

describe("сводка готовности сборщиков", () => {
  it("при полной конфигурации готовы все", () => {
    for (const c of describeCapabilityReadiness(READY_ENV)) {
      expect(c.ready, `${c.capability}: ${c.detail}`).toBe(true);
    }
  });

  it.each([
    ["GOOGLE_EXTERNAL_SERP_PROVIDER", "ORION Search Profile (поверхности Google)"],
    ["GOOGLE_EXTERNAL_SERP_API_KEY", "ORION Search Profile (поверхности Google)"],
    ["ARSENKIN_API_TOKEN", "Arsenkin (5 агентов обогащения)"],
    ["YANDEX_SEARCH_FOLDER_ID", "Yandex Search (Cloud Search API v2)"],
    ["OPENAI_API_KEY", "AI-аналитик (текст отчёта)"],
  ])("без %s сборщик «%s» выключен и переменная названа", (variable, capability) => {
    const env = { ...READY_ENV };
    delete env[variable];
    const entry = readiness(env).get(capability);
    expect(entry?.ready).toBe(false);
    expect(entry?.detail).toContain(variable);
  });

  it("псевдоним SERPER_API_KEY считается ключом", () => {
    const env = { ...READY_ENV };
    delete env.GOOGLE_EXTERNAL_SERP_API_KEY;
    env.SERPER_API_KEY = "serper-key";
    expect(readiness(env).get("ORION Search Profile (поверхности Google)")?.ready).toBe(true);
  });

  it("значения переменных в сводку не попадают", () => {
    const secrets = ["t0ken", "serper-key", "ya-key", "sk-test"];
    const text = JSON.stringify(describeCapabilityReadiness(READY_ENV));
    for (const s of secrets) expect(text).not.toContain(s);
  });
});

describe("проверка окружения знает про Arsenkin", () => {
  it("включённый Arsenkin без токена — критическая ошибка", () => {
    const { errors } = validateDigitalProfileEnv({
      DIGITAL_PROFILE_ENABLED: "true",
      DATABASE_URL: "postgres://x",
      DIGITAL_PROFILE_SIGNED_URL_SECRET: "0123456789abcdefgh",
      ARSENKIN_ENABLED: "true",
    });
    expect(errors.join("\n")).toContain("ARSENKIN_API_TOKEN");
  });

  it("выключенный Arsenkin — предупреждение о неполном отчёте", () => {
    const { warnings } = validateDigitalProfileEnv({
      DIGITAL_PROFILE_ENABLED: "true",
      DATABASE_URL: "postgres://x",
      DIGITAL_PROFILE_SIGNED_URL_SECRET: "0123456789abcdefgh",
    });
    expect(warnings.join("\n")).toContain("ARSENKIN_ENABLED");
  });
});
