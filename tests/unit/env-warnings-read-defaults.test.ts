import { describe, expect, it } from "vitest";
import { validateDigitalProfileEnv } from "@/modules/digital-profile/config/env-validation";
import {
  isOfflineEnrichmentMode,
  offlineEnrichmentEnvWarning,
} from "@/modules/digital-profile/config/offline-enrichment-guard";

/**
 * Площадка, где переменных-переключателей нет вовсе: по правилу продукта в
 * окружении живут только секреты, всё остальное имеет значение по умолчанию,
 * при котором продукт работает целиком (`config/defaults.ts`).
 */
const DEPLOY_ENV_WITH_SECRETS_ONLY = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@host:5432/db",
  DIGITAL_PROFILE_SESSION_SECRET: "a-long-enough-session-secret-value",
  YANDEX_SEARCH_API_KEY: "yandex-api-key-value-long-enough",
  YANDEX_SEARCH_FOLDER_ID: "folder-id",
  SERPER_API_KEY: "serper-api-key-value-long-enough",
  ARSENKIN_API_TOKEN: "arsenkin-token-value-long-enough",
  OPENAI_API_KEY: "sk-openai-key-value-long-enough",
} as Record<string, string | undefined>;

describe("предупреждения окружения читают те же значения, что и рабочий код", () => {
  it("не жалуется на ключи Programmable Search при внешней выдаче", () => {
    const { warnings } = validateDigitalProfileEnv(DEPLOY_ENV_WITH_SECRETS_ONLY);
    expect(warnings.join("\n")).not.toContain("GOOGLE_SEARCH_ENGINE_ID");
  });

  it("не объявляет стратегию Google невыбранной, когда работает значение по умолчанию", () => {
    const { warnings } = validateDigitalProfileEnv(DEPLOY_ENV_WITH_SECRETS_ONLY);
    expect(warnings.join("\n")).not.toContain("GOOGLE_SEARCH_PROVIDER is not set");
  });

  it("не помечает прогон офлайновым, когда обогащение включено по умолчанию", () => {
    // Отметка доезжала до клиента: «Обогащение выполнялось в офлайн-режиме —
    // страницы подсказок/AI будут пустыми» при полностью отработавшем Arsenkin.
    expect(isOfflineEnrichmentMode(DEPLOY_ENV_WITH_SECRETS_ONLY)).toBe(false);
    expect(offlineEnrichmentEnvWarning(DEPLOY_ENV_WITH_SECRETS_ONLY)).toBeNull();
  });

  it("честно жалуется, когда обогащение выключено явно", () => {
    const env = { ...DEPLOY_ENV_WITH_SECRETS_ONLY, ARSENKIN_ENABLED: "false" };
    expect(isOfflineEnrichmentMode(env)).toBe(true);
    expect(offlineEnrichmentEnvWarning(env)).toContain("ARSENKIN_ENABLED");
  });

  it("честно жалуется, когда сеть выключена", () => {
    const env = { ...DEPLOY_ENV_WITH_SECRETS_ONLY, NETWORK_CALLS: "0" };
    expect(offlineEnrichmentEnvWarning(env)).toContain("NETWORK_CALLS=0");
  });

  it("ключи Programmable Search требуются, когда стратегия выбрана явно", () => {
    const env = { ...DEPLOY_ENV_WITH_SECRETS_ONLY, GOOGLE_SEARCH_PROVIDER: "custom_search" };
    expect(validateDigitalProfileEnv(env).warnings.join("\n")).toContain("GOOGLE_SEARCH_ENGINE_ID");
  });
});
