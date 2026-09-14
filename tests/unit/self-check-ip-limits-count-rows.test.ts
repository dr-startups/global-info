import { describe, expect, it, vi } from "vitest";
import { countRecentChecksByIp, ipLimitReached } from "@/modules/self-check/quotas";
import { createSelfCheck } from "@/modules/self-check/service";
import { TEST_NOW, fakeDb, refusal, selfCheckRow } from "../support/self-check-fakes";

/**
 * Лимит проверок с одного адреса считается по строкам таблицы проверок.
 *
 * Каждая проверка стоит денег (панель персоны, прогон), а лимитов расхода в
 * приложении до сайта не было. Счётчиков в памяти процесса нет: деплой или
 * второй процесс обнулили бы их, а строки таблицы переживают и то и другое.
 * Адрес хранится хешем, поэтому лимит работает и после обезличивания записи.
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

describe("решение по счётчикам", () => {
  it("пока строк меньше лимитов — можно", () => {
    expect(ipLimitReached({ lastHour: 2, lastDay: 4 }, {})).toBe(false);
  });

  it("три строки за час — четвёртой нет", () => {
    expect(ipLimitReached({ lastHour: 3, lastDay: 3 }, {})).toBe(true);
  });

  it("суточный лимит действует отдельно от часового", () => {
    expect(ipLimitReached({ lastHour: 0, lastDay: 5 }, {})).toBe(true);
  });

  it("лимиты берутся из настроек", () => {
    const env = { SELF_CHECK_IP_HOURLY_LIMIT: "10", SELF_CHECK_IP_DAILY_LIMIT: "20" };
    expect(ipLimitReached({ lastHour: 3, lastDay: 5 }, env)).toBe(false);
  });
});

describe("счёт по строкам", () => {
  it("строки этого адреса за последний час и за последние сутки", async () => {
    const at = (ms: number) => new Date(TEST_NOW.getTime() - ms);
    const { db } = fakeDb({
      selfChecks: [
        selfCheckRow({ id: "a1", ipHash: "ip-a", createdAt: at(10 * MIN) }),
        selfCheckRow({ id: "a2", ipHash: "ip-a", createdAt: at(2 * HOUR) }),
        selfCheckRow({ id: "a3", ipHash: "ip-a", createdAt: at(23 * HOUR) }),
        selfCheckRow({ id: "a4", ipHash: "ip-a", createdAt: at(25 * HOUR) }),
        selfCheckRow({ id: "b1", ipHash: "ip-b", createdAt: at(1 * MIN) }),
        selfCheckRow({ id: "a5", ipHash: "ip-a", createdAt: at(5 * MIN), honeypotTripped: true, caseId: null }),
      ],
    });
    expect(await countRecentChecksByIp(db as never, "ip-a", TEST_NOW)).toEqual({ lastHour: 2, lastDay: 4 });
  });
});

describe("создание упирается в лимит", () => {
  const SECRET = "limits-test-secret-0123456789abcdef";
  let seq = 0;

  function create(db: unknown, ip: string, birthDate: string) {
    seq += 1;
    return createSelfCheck(
      {
        body: { fullName: "Иванов Иван Иванович", birthDate, consent: true, captchaToken: "t" },
        ip,
        userAgent: "ua",
        cookieToken: null,
      },
      {
        db: db as never,
        now: () => TEST_NOW,
        env: {} as NodeJS.ProcessEnv,
        secret: SECRET,
        newId: () => `check-${seq}`,
        newPublicId: () => `public-${seq}-0123456789abcdefgh`,
        verifyCaptcha: async () => ({ verified: true as const }),
        saveSubjectProfile: vi.fn(),
      }
    );
  }

  it("четвёртая проверка за час с одного адреса — 429 RATE_LIMITED, кейс не заводится", async () => {
    const { db, state } = fakeDb();
    for (const day of ["10", "11", "12"]) {
      expect((await create(db, "203.0.113.7", `1985-03-${day}`)).kind).toBe("created");
    }
    const err = await refusal(create(db, "203.0.113.7", "1985-03-13"));
    expect(err).toMatchObject({ status: 429, code: "FORBIDDEN", details: { reason: "RATE_LIMITED" } });
    expect(state.cases).toHaveLength(3);
    expect(state.selfChecks).toHaveLength(3);
    const blocked = state.audits.find((a) => a.action === "SELF_CHECK_BLOCKED");
    expect(blocked).toMatchObject({
      caseId: null,
      ipAddress: "203.0.113.7",
      metadata: { reason: "RATE_LIMITED", ipHash: state.selfChecks[0]!.ipHash },
    });
  });

  it("чужой адрес в чужой лимит не упирается", async () => {
    const { db } = fakeDb();
    for (const day of ["10", "11", "12"]) await create(db, "203.0.113.7", `1985-03-${day}`);
    expect((await create(db, "198.51.100.1", "1985-03-13")).kind).toBe("created");
  });
});
