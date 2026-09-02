/**
 * Умолчание единственного работающего источника комплаенса записано один раз —
 * в `config/defaults.ts`, — и опечатка в переменной его не выключает.
 *
 * До этого шага `compliance-providers/config.ts` читал флаг своим `envBool`, у
 * которого понятны только слова «включено»: всё остальное, включая `maybe` и
 * `yes!`, читалось как «выключено». Замерено на `233ebd1`:
 * `OPEN_SANCTIONS_ENABLED=maybe` давал `DISABLED`, то есть опечатка молча
 * убирала раздел комплаенса из отчёта. `boolSetting` на непонятом значении
 * возвращает умолчание — в этом вся разница, и без проверки на непонятом
 * значении правка неотличима от прежнего разбора.
 *
 * Разрешением у этого источника служит не флаг, а адрес и ключ: облачный
 * сервис отвечает по своему адресу, самостоятельно поднятый `yente` — по
 * своему. Поэтому умолчание «включён» ничего не открывает и не тратит, а
 * наблюдаемым здесь служит именно флаг (`status.enabled`): составной статус
 * отвечает ещё и на вопрос о ключе, и его держит соседняя проверка
 * `open-sanctions-key-is-the-permission.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOLEAN_DEFAULTS,
  boolSetting,
} from "@/modules/digital-profile/config/defaults";
import type { ComplianceProviderStatus } from "@/modules/digital-profile/compliance-providers/types";

/**
 * Транспорт подменён, а не наблюдаем: «в сеть не ходил» доказывается счётом
 * вызовов, и живой запрос к OpenSanctions из офлайн-контура запрещён.
 */
const http = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("@/modules/digital-profile/providers/http", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postJson: async (url: string) => {
    http.calls.push(url);
    return { responses: { subject: { results: [] } } };
  },
}));

/** Переменные, которые эти проверки трогают, — снимаются и возвращаются целиком. */
const TOUCHED = [
  "OPEN_SANCTIONS_ENABLED",
  "OPEN_SANCTIONS_API_BASE_URL",
  "OPEN_SANCTIONS_API_KEY",
  "DIGITAL_PROFILE_COMPLIANCE_REAL_ENABLED",
] as const;

const SAVED = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));

function applyEnv(env: Record<string, string>): void {
  for (const key of TOUCHED) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function restoreEnv(): void {
  for (const key of TOUCHED) {
    const value = SAVED[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

/**
 * Конфигурация провайдеров — модульная `const`, снимаемая при импорте. Без
 * пересоздания модуля проверка увидела бы значение, снятое до правки окружения.
 */
async function statusUnder(
  env: Record<string, string>
): Promise<ComplianceProviderStatus> {
  applyEnv(env);
  vi.resetModules();
  const { getComplianceProviderStatus } = await import(
    "@/modules/digital-profile/compliance-providers/config"
  );
  return getComplianceProviderStatus("OPEN_SANCTIONS");
}

async function screenUnder(env: Record<string, string>) {
  applyEnv(env);
  vi.resetModules();
  const { openSanctionsProvider } = await import(
    "@/modules/digital-profile/compliance-providers/open-sanctions-provider"
  );
  http.calls.length = 0;
  return openSanctionsProvider.screenPerson({
    caseId: "case-open-sanctions-flag",
    subjectFullName: "Иванов Иван Иванович",
  });
}

afterEach(restoreEnv);

describe("умолчание OpenSanctions живёт в config/defaults.ts", () => {
  it("значение записано среди настроек-переключателей и читается общим разбором", () => {
    expect(BOOLEAN_DEFAULTS.OPEN_SANCTIONS_ENABLED).toBe(true);
    expect(boolSetting("OPEN_SANCTIONS_ENABLED", {})).toBe(true);
  });

  it("при пустом окружении источник включён, а недостаёт ему только ключа", async () => {
    const status = await statusUnder({});
    expect(status.enabled).toBe(true);
    expect(status.missingConfigKeys).toEqual(["OPEN_SANCTIONS_API_KEY"]);
  });

  it("с ключом источник настроен полностью", async () => {
    const status = await statusUnder({ OPEN_SANCTIONS_API_KEY: "os-key" });
    expect(status.status).toBe("ENABLED");
    expect(status.missingConfigKeys).toEqual([]);
  });

  it("общий рубильник платных подписок его не выключает", async () => {
    // У OpenSanctions нет контракта, поэтому он и не подчиняется выключателю
    // платных подписок: иначе стенд без договоров остался бы без комплаенса.
    const status = await statusUnder({ DIGITAL_PROFILE_COMPLIANCE_REAL_ENABLED: "false" });
    expect(status.enabled).toBe(true);
  });
});

describe("выключить источник можно только осознанно", () => {
  it.each(["off", "0", "false", "no"])(
    "OPEN_SANCTIONS_ENABLED=%s выключает источник",
    async (value) => {
      const status = await statusUnder({ OPEN_SANCTIONS_ENABLED: value });
      expect(status.status).toBe("DISABLED");
    }
  );

  it.each(["maybe", "yes!", "ага", "enabled"])(
    "непонятое значение %j источник не выключает",
    async (value) => {
      const status = await statusUnder({ OPEN_SANCTIONS_ENABLED: value });
      expect(status.enabled).toBe(true);
      expect(status.status).not.toBe("DISABLED");
    }
  );
});

describe("выключенный источник в сеть не ходит", () => {
  it("отказ называет причину и не делает ни одного запроса", async () => {
    const result = await screenUnder({ OPEN_SANCTIONS_ENABLED: "off" });
    expect(result.status).toBe("DISABLED");
    expect(result.error?.code).toBe("PROVIDER_DISABLED");
    expect(http.calls).toEqual([]);
  });

  it("включённый источник запрос делает — счёт вызовов не вакуумный", async () => {
    // С ключом: без него разрешения нет и вызова не будет по другой причине.
    const result = await screenUnder({ OPEN_SANCTIONS_API_KEY: "os-key" });
    expect(result.status).toBe("SUCCESS");
    expect(http.calls).toHaveLength(1);
  });
});
