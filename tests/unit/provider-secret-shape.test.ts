import { describe, expect, it } from "vitest";
import {
  configuredSecret,
  isConfiguredSecret,
  secretDefect,
  secretDefectMessage,
} from "../../src/modules/digital-profile/providers/secret-shape";
import { computeAvailability } from "../../src/modules/digital-profile/providers/config";

/**
 * Шаг 04.2.
 *
 * На живом прогоне `/api/digital-profile/providers` показывал
 * `GOOGLE status=ENABLED supportsRealCalls=true missingConfigKeys=[]`,
 * при том что `SERPER_API_KEY` содержал `<<<FILL>>>`. Готовность проверялась
 * непустотой строки. Оператор видел зелёный статус, а правду узнавал из
 * пустого отчёта — то есть после того, как прогон уже потрачен.
 */

describe("заглушка ключом не считается", () => {
  it("узнаёт заглушку из .env.example", () => {
    expect(secretDefect("<<<FILL>>>")).toBe("placeholder");
    expect(secretDefect("<your-api-key>")).toBe("placeholder");
    expect(secretDefect("${SERPER_API_KEY}")).toBe("placeholder");
    expect(secretDefect("change-me")).toBe("placeholder");
    expect(secretDefect("PASTE_YOUR_KEY_HERE")).toBe("placeholder");
    expect(secretDefect("replace-me-with-the-real-key")).toBe("placeholder");
  });

  it("узнаёт слова, которыми ключ не бывает", () => {
    for (const v of ["TODO", "todo", "placeholder", "none", "null", "test", "xxx", "-"]) {
      expect(secretDefect(v), v).toBe("placeholder");
    }
  });

  it("строка из одного символа — заглушка", () => {
    expect(secretDefect("xxxxxxxxxxxx")).toBe("placeholder");
    expect(secretDefect("000000000000")).toBe("placeholder");
  });

  it("пустое и слишком короткое различаются", () => {
    expect(secretDefect("")).toBe("empty");
    expect(secretDefect("   ")).toBe("empty");
    expect(secretDefect(undefined)).toBe("empty");
    expect(secretDefect("ab12cd")).toBe("too_short");
  });
});

describe("настоящий ключ проверку проходит", () => {
  it("ключи используемых провайдеров признаются настроенными", () => {
    // Ложное срабатывание здесь выключает работающего провайдера — это хуже
    // пропущенной заглушки, поэтому формы настоящих ключей проверяются явно.
    //
    // Значения намеренно не повторяют узнаваемые префиксы вендоров: предикат
    // смотрит на длину, набор символов, слова-заглушки и повторы, а префикс ему
    // безразличен — то есть реалистичный вид не добавил бы покрытия, зато
    // приучал бы держать в репозитории строки, неотличимые от настоящих
    // ключей. Проверяются именно формы: длинный hex, смешанный регистр с
    // дефисом, подчёркивания.
    const real = [
      "4f2c8b1e9a7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b", // 40 шестнадцатеричных
      "Zz9-QqWwEeRrTtYyUuIiOoPpAaSsDdFfGgHh", // смешанный регистр и дефис
      "Kk1Ll2Mm3Nn4Oo5Pp6Qq7Rr8Ss9Tt0UuVvWwXx", // смешанный регистр, 38 знаков
      "unit_test_value_with_underscores_42",
    ];
    for (const key of real) {
      expect(isConfiguredSecret(key), key).toBe(true);
      expect(configuredSecret(key)).toBe(key);
    }
  });

  it("заглушка обнуляется, чтобы прежняя проверка `if (!key)` работала", () => {
    expect(configuredSecret("<<<FILL>>>")).toBe("");
    expect(configuredSecret("  4f2c8b1e9a7d6c5b4a3f2e1d  ")).toBe("4f2c8b1e9a7d6c5b4a3f2e1d");
  });

  it("объяснение называет ключ и причину", () => {
    expect(secretDefectMessage("SERPER_API_KEY", "placeholder")).toMatch(/SERPER_API_KEY/);
    expect(secretDefectMessage("SERPER_API_KEY", "placeholder")).toMatch(/заглушк/i);
    expect(secretDefectMessage("YANDEX_SEARCH_API_KEY", "empty")).toMatch(/не задан/);
  });
});

describe("статус ENABLED означает «проверено»", () => {
  it("непригодный ключ даёт NOT_CONFIGURED с названной причиной", () => {
    const res = computeAvailability("GOOGLE", {
      masterEnabled: true,
      enabled: true,
      hasKeys: false,
      keyDefects: ["GOOGLE_EXTERNAL_SERP_API_KEY содержит заглушку, а не ключ"],
    });
    expect(res.status).toBe("NOT_CONFIGURED");
    expect(res.message).toMatch(/заглушку/);
  });

  it("без объяснения сообщение остаётся прежним", () => {
    const res = computeAvailability("YANDEX", {
      masterEnabled: true,
      enabled: true,
      hasKeys: false,
    });
    expect(res.status).toBe("NOT_CONFIGURED");
    expect(res.message).toMatch(/credentials are missing/);
  });

  it("выключенный провайдер про ключи не рассуждает", () => {
    const res = computeAvailability("GOOGLE", {
      masterEnabled: true,
      enabled: false,
      hasKeys: false,
      keyDefects: ["GOOGLE_EXTERNAL_SERP_API_KEY содержит заглушку, а не ключ"],
    });
    expect(res.status).toBe("DISABLED");
  });

  it("пригодные ключи дают ENABLED", () => {
    expect(
      computeAvailability("YANDEX", { masterEnabled: true, enabled: true, hasKeys: true }).status
    ).toBe("ENABLED");
  });
});
