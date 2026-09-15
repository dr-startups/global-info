import { describe, expect, it, vi } from "vitest";
import { createSelfCheck } from "@/modules/self-check/service";
import { createSelfCheckToken } from "@/modules/self-check/token";
import { DAY_MS, TEST_NOW, fakeDb } from "../support/self-check-fakes";

/**
 * Повтор тех же данных из того же браузера ведёт к прежней проверке.
 *
 * Решение заказчика 14.09: браузер, у которого есть cookie проверки этих же
 * ФИО и даты рождения, возвращается к ней, и новая проверка не создаётся;
 * без такой cookie — другое устройство, очищенный браузер, другой человек —
 * запускается новая проверка. По одним ФИО и дате чужую проверку открыть
 * нельзя: ключ к ней — cookie, а не знание данных.
 */

const SECRET = "dedupe-test-secret-0123456789abcdef";

const body = {
  fullName: "Семёнов Иван Иванович",
  birthDate: "1985-03-12",
  consent: true,
  captchaToken: "captcha-token",
};

let seq = 0;

function create(
  db: unknown,
  opts: { form?: Record<string, unknown>; cookieToken?: string | null; now?: Date; env?: Record<string, string> } = {}
) {
  seq += 1;
  const id = `check-${seq}`;
  return createSelfCheck(
    {
      body: { ...body, ...opts.form },
      ip: "203.0.113.7",
      userAgent: "ua",
      cookieToken: opts.cookieToken ?? null,
    },
    {
      db: db as never,
      now: () => opts.now ?? TEST_NOW,
      env: (opts.env ?? {}) as NodeJS.ProcessEnv,
      secret: SECRET,
      newId: () => id,
      newPublicId: () => `public-${id}-0123456789abcdef`,
      verifyCaptcha: async () => ({ verified: true as const }),
      saveSubjectProfile: vi.fn(),
    }
  );
}

async function first(db: unknown, form: Record<string, unknown> = {}) {
  const result = await create(db, { form });
  if (result.kind !== "created") throw new Error("ожидалось создание");
  return result;
}

describe("с cookie прежней проверки этих данных", () => {
  it("возвращает прежнюю проверку и не заводит новой", async () => {
    const { db, state } = fakeDb();
    const initial = await first(db);
    const again = await create(db, { cookieToken: initial.token });
    expect(again).toEqual({ kind: "existing", existingPublicId: initial.publicId });
    expect(state.cases).toHaveLength(1);
    expect(state.selfChecks).toHaveLength(1);
  });

  it("регистр, «ё» и лишние пробелы — те же данные", async () => {
    const { db } = fakeDb();
    const initial = await first(db);
    const again = await create(db, {
      cookieToken: initial.token,
      form: { fullName: "  семенов   иван иванович " },
    });
    expect(again.kind).toBe("existing");
  });

  it("возврат к своей проверке не тратит лимит адреса", async () => {
    const { db } = fakeDb();
    const env = { SELF_CHECK_IP_HOURLY_LIMIT: "1" };
    const initial = await create(db, { env });
    if (initial.kind !== "created") throw new Error("ожидалось создание");
    const again = await create(db, { cookieToken: initial.token, env });
    expect(again.kind).toBe("existing");
  });
});

describe("новая проверка", () => {
  it("без cookie те же данные запускают новую проверку", async () => {
    const { db, state } = fakeDb();
    await first(db);
    const again = await create(db);
    expect(again.kind).toBe("created");
    expect(state.cases).toHaveLength(2);
    expect(state.selfChecks).toHaveLength(2);
  });

  it("cookie проверки другого человека — новая проверка", async () => {
    const { db } = fakeDb();
    const other = await first(db, { fullName: "Петров Пётр Петрович" });
    const again = await create(db, { cookieToken: other.token });
    expect(again.kind).toBe("created");
  });

  it("другая дата рождения — другой человек", async () => {
    const { db } = fakeDb();
    const initial = await first(db);
    const again = await create(db, { cookieToken: initial.token, form: { birthDate: "1985-03-13" } });
    expect(again.kind).toBe("created");
  });

  it("за окном дедупликации — новая проверка, хотя cookie ещё жива", async () => {
    const { db } = fakeDb();
    const env = { SELF_CHECK_DEDUPE_DAYS: "5" };
    const initial = await create(db, { env });
    if (initial.kind !== "created") throw new Error("ожидалось создание");
    const later = new Date(TEST_NOW.getTime() + 6 * DAY_MS);
    const inside = new Date(TEST_NOW.getTime() + 4 * DAY_MS);
    expect((await create(db, { cookieToken: initial.token, env, now: inside })).kind).toBe("existing");
    expect((await create(db, { cookieToken: initial.token, env, now: later })).kind).toBe("created");
  });

  it("обезличенная проверка не переиспользуется", async () => {
    const { db, state } = fakeDb();
    const initial = await first(db);
    state.selfChecks[0]!.anonymizedAt = TEST_NOW;
    expect((await create(db, { cookieToken: initial.token })).kind).toBe("created");
  });

  it.each([
    ["упавшая", { status: "FAILED", blockedReason: "RUN_FAILED" }],
    ["без вывода", { status: "DONE", verdict: "INSUFFICIENT_DATA" }],
  ])("%s проверка — новая: макет зовёт запустить проверку заново", async (_label, outcome) => {
    const { db, state } = fakeDb();
    const initial = await first(db);
    Object.assign(state.selfChecks[0]!, outcome);
    expect((await create(db, { cookieToken: initial.token })).kind).toBe("created");
  });

  it("проверка с результатом — прежняя", async () => {
    const { db, state } = fakeDb();
    const initial = await first(db);
    Object.assign(state.selfChecks[0]!, { status: "DONE", verdict: "NEGATIVE_FOUND" });
    expect((await create(db, { cookieToken: initial.token })).kind).toBe("existing");
  });

  it("токен с чужой подписью — как без cookie", async () => {
    const { db } = fakeDb();
    const initial = await first(db);
    const forged = await createSelfCheckToken(
      String(initial.checkId),
      "attacker-secret-0123456789abcdef",
      { now: TEST_NOW }
    );
    expect((await create(db, { cookieToken: forged })).kind).toBe("created");
  });
});
