/**
 * Разрешение — ключ, а не флаг: без ключа ФИО в чужое облако не уезжает.
 *
 * Замер живого прогона 91 (31.08.2026): при пустом `OPEN_SANCTIONS_API_KEY`
 * `getComplianceProviderStatus("OPEN_SANCTIONS")` отдавал `ENABLED` с пустым
 * списком недостающих ключей, и запрос уходил на `https://api.opensanctions.org`
 * **без заголовка авторизации** — с именем, датой рождения и гражданством
 * живого человека в теле. Облако отвечало 401, проверка не состоялась, а данные
 * субъекта уже ушли.
 *
 * Ключ обязателен ровно тогда, когда адрес равен облачному умолчанию:
 * самостоятельно поднятый `yente` отвечает анонимно по своему адресу, и
 * требовать ключ безусловно значило бы объявить ненастроенным работающий
 * экземпляр — то есть подменить правило «разрешение — ключ» правилом
 * «разрешение — облако».
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** Транспорт подменён: «в сеть не ходил» доказывается счётом вызовов. */
const http = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; body: unknown; headers: unknown }>,
}));

vi.mock("@/modules/digital-profile/providers/http", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postJson: async (url: string, body: unknown, options: { headers?: unknown }) => {
    http.calls.push({ url, body, headers: options?.headers });
    return { responses: { subject: { results: [] } } };
  },
}));

const TOUCHED = [
  "OPEN_SANCTIONS_ENABLED",
  "OPEN_SANCTIONS_API_BASE_URL",
  "OPEN_SANCTIONS_API_KEY",
] as const;

const SAVED = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

/**
 * Конфигурация провайдеров — модульная `const`, снятая при импорте: без
 * пересоздания модуля проверка увидела бы окружение, прочитанное до правки.
 */
async function underEnv(env: Record<string, string>) {
  for (const key of TOUCHED) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();
  http.calls.length = 0;
  const [{ getComplianceProviderStatus }, { openSanctionsProvider }] = await Promise.all([
    import("@/modules/digital-profile/compliance-providers/config"),
    import("@/modules/digital-profile/compliance-providers/open-sanctions-provider"),
  ]);
  return {
    status: getComplianceProviderStatus("OPEN_SANCTIONS"),
    screen: () =>
      openSanctionsProvider.screenPerson({
        caseId: "case-open-sanctions-key",
        subjectFullName: "Умар Назарович Кремлев",
        dateOfBirth: "1982-11-01",
        country: "Россия",
      }),
  };
}

afterEach(() => {
  for (const key of TOUCHED) {
    const value = SAVED[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("облачный адрес без ключа — источник не настроен", () => {
  it("недостающим назван именно ключ, а не адрес", async () => {
    const { status } = await underEnv({});
    expect(status.status).toBe("NOT_CONFIGURED");
    expect(status.missingConfigKeys).toEqual(["OPEN_SANCTIONS_API_KEY"]);
    expect(status.configured).toBe(false);
  });

  it("проверка отказывает и ни одного запроса не делает", async () => {
    const { screen } = await underEnv({});
    const result = await screen();
    expect(result.status).toBe("NOT_CONFIGURED");
    expect(result.error?.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(result.error?.message).toContain("OPEN_SANCTIONS_API_KEY");
    // Главное утверждение шага: имя живого человека в облако не уехало.
    expect(http.calls).toEqual([]);
  });

  it("пустая строка ключа — это отсутствие ключа", async () => {
    // Ровно так ключ записан в локальном `.env`: строка есть, значения нет.
    const { status, screen } = await underEnv({ OPEN_SANCTIONS_API_KEY: "   " });
    expect(status.status).toBe("NOT_CONFIGURED");
    expect((await screen()).status).toBe("NOT_CONFIGURED");
    expect(http.calls).toEqual([]);
  });
});

describe("свой экземпляр по явному адресу работает анонимно", () => {
  it("yente без ключа остаётся настроенным и запрос делает", async () => {
    const { status, screen } = await underEnv({
      OPEN_SANCTIONS_API_BASE_URL: "http://yente.internal:8000",
    });
    expect(status.status).toBe("ENABLED");
    expect(status.missingConfigKeys).toEqual([]);
    expect((await screen()).status).toBe("SUCCESS");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe("http://yente.internal:8000/match/default");
    expect(http.calls[0]!.headers).toEqual({});
  });
});

describe("облако с ключом проверяется по-прежнему", () => {
  it("ключ уходит заголовком, а не в адресе", async () => {
    const { status, screen } = await underEnv({ OPEN_SANCTIONS_API_KEY: "os-key-live" });
    expect(status.status).toBe("ENABLED");
    expect((await screen()).status).toBe("SUCCESS");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]!.url).toBe("https://api.opensanctions.org/match/default");
    expect(http.calls[0]!.headers).toEqual({ authorization: "ApiKey os-key-live" });
  });

  it("выключенный источник не настроен и без ключа не жалуется на ключ", async () => {
    // Выключен — значит выключен: список недостающих ключей отказ не объясняет.
    const { status, screen } = await underEnv({ OPEN_SANCTIONS_ENABLED: "off" });
    expect(status.status).toBe("DISABLED");
    expect((await screen()).status).toBe("DISABLED");
    expect(http.calls).toEqual([]);
  });
});
