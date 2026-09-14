import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  boolSetting,
  numberSetting,
  textSetting,
} from "@/modules/digital-profile/config/defaults";
import { describeSelfCheckSettings } from "@/modules/digital-profile/config/env-validation";

/**
 * Настройки сайта самопроверки работают без единой переменной.
 *
 * Правило проекта то же, что у сборщиков: в окружении живут только секреты, а
 * у всего остального есть значение, при котором продукт работает. Лимиты
 * расхода и сроки хранения согласованы с заказчиком — числа ниже взяты из
 * утверждённой таблицы настроек, а не из кода.
 */

const NO_ENV: Record<string, string | undefined> = {};

describe("значения по умолчанию", () => {
  it("рубильник проверки включён, индексация сайта закрыта", () => {
    expect(boolSetting("SELF_CHECK_ENABLED", NO_ENV)).toBe(true);
    // Тестовая выкладка не должна попасть в выдачу: индексацию открывает решение о запуске.
    expect(boolSetting("SITE_INDEXING_ENABLED", NO_ENV)).toBe(false);
  });

  it.each([
    ["SELF_CHECK_DAILY_RUN_LIMIT", 25],
    ["SELF_CHECK_IP_HOURLY_LIMIT", 3],
    ["SELF_CHECK_IP_DAILY_LIMIT", 5],
    ["SELF_CHECK_DEDUPE_DAYS", 30],
    ["SELF_CHECK_RETENTION_DAYS", 30],
    ["SELF_CHECK_TOKEN_TTL_DAYS", 30],
    ["SELF_CHECK_POLL_INTERVAL_MS", 7000],
  ] as const)("%s = %i", (name, value) => {
    expect(numberSetting(name, NO_ENV)).toBe(value);
  });

  it("адрес сайта локальный, Метрика и коды верификации пусты", () => {
    expect(textSetting("SITE_PUBLIC_ORIGIN", NO_ENV)).toBe("http://localhost:3000");
    expect(textSetting("YANDEX_METRIKA_ID", NO_ENV)).toBe("");
    expect(textSetting("SITE_YANDEX_VERIFICATION", NO_ENV)).toBe("");
    expect(textSetting("SITE_GOOGLE_VERIFICATION", NO_ENV)).toBe("");
  });
});

describe("переопределения", () => {
  it("целое число из переменной принимается", () => {
    expect(numberSetting("SELF_CHECK_DAILY_RUN_LIMIT", { SELF_CHECK_DAILY_RUN_LIMIT: "40" })).toBe(40);
    expect(numberSetting("SELF_CHECK_DAILY_RUN_LIMIT", { SELF_CHECK_DAILY_RUN_LIMIT: " 12 " })).toBe(12);
  });

  it.each(["abc", "-5", "2.5", "1e3", "25 проверок"])(
    "непонятое «%s» читается как значение по умолчанию, а не снимает лимит",
    (raw) => {
      expect(numberSetting("SELF_CHECK_DAILY_RUN_LIMIT", { SELF_CHECK_DAILY_RUN_LIMIT: raw })).toBe(25);
    }
  );

  it("лимит не опускается ниже одного: останавливает проверку рубильник, а не ноль", () => {
    expect(numberSetting("SELF_CHECK_IP_HOURLY_LIMIT", { SELF_CHECK_IP_HOURLY_LIMIT: "0" })).toBe(1);
  });

  it("статус опрашивается не чаще раза в пять секунд", () => {
    const poll = (raw: string) =>
      numberSetting("SELF_CHECK_POLL_INTERVAL_MS", { SELF_CHECK_POLL_INTERVAL_MS: raw });
    expect(poll("1000")).toBe(5000);
    expect(poll("5000")).toBe(5000);
    expect(poll("9000")).toBe(9000);
  });

  it("код верификации читается как есть, с регистром", () => {
    const env = { SITE_GOOGLE_VERIFICATION: "AbC-dEf_123", YANDEX_METRIKA_ID: " 98765432 " };
    expect(textSetting("SITE_GOOGLE_VERIFICATION", env)).toBe("AbC-dEf_123");
    expect(textSetting("YANDEX_METRIKA_ID", env)).toBe("98765432");
  });
});

describe("сводка настроек сайта в логе старта", () => {
  const text = (env: Record<string, string | undefined>) => describeSelfCheckSettings(env).join("\n");
  const CAPTCHA = {
    SMARTCAPTCHA_SERVER_KEY: "ysc2_server-secret-value",
    SMARTCAPTCHA_CLIENT_KEY: "ysc1_client-key-value",
  };

  it("без ключей капчи называет недостающие переменные", () => {
    expect(text(NO_ENV)).toContain("SMARTCAPTCHA_SERVER_KEY");
    expect(text({ SMARTCAPTCHA_SERVER_KEY: CAPTCHA.SMARTCAPTCHA_SERVER_KEY })).toContain(
      "SMARTCAPTCHA_CLIENT_KEY"
    );
  });

  it("с ключами говорит, что капча настроена, и значений не печатает", () => {
    const out = text(CAPTCHA);
    expect(out).toContain("капча настроена");
    expect(out).not.toContain("SMARTCAPTCHA_");
    for (const value of Object.values(CAPTCHA)) expect(out).not.toContain(value);
  });

  it("выключенный рубильник виден по имени переменной", () => {
    expect(text({ SELF_CHECK_ENABLED: "false" })).toContain("SELF_CHECK_ENABLED");
    expect(text(NO_ENV)).not.toContain("SELF_CHECK_ENABLED");
  });

  it("лимиты печатаются теми числами, которые действуют", () => {
    expect(text(NO_ENV)).toContain("25 прогонов в сутки");
    expect(text({ SELF_CHECK_DAILY_RUN_LIMIT: "40" })).toContain("40 прогонов в сутки");
  });

  it("закрытая индексация видна по имени переменной", () => {
    expect(text(NO_ENV)).toContain("SITE_INDEXING_ENABLED");
    expect(text({ SITE_INDEXING_ENABLED: "true" })).not.toContain("SITE_INDEXING_ENABLED");
  });
});

describe(".env.example", () => {
  const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");

  it("описывает ключи капчи", () => {
    expect(example).toMatch(/^SMARTCAPTCHA_SERVER_KEY=/m);
    expect(example).toMatch(/^SMARTCAPTCHA_CLIENT_KEY=/m);
  });

  it("не присваивает настроек сайта: у них есть значения по умолчанию", () => {
    expect(example).not.toMatch(/^(SELF_CHECK_|SITE_|YANDEX_METRIKA_ID)\w*\s*=/m);
  });
});
