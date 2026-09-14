import { describe, expect, it, vi } from "vitest";
import {
  buildSelfCheckPersona,
  createSelfCheck,
  decideSelfCheckPersona,
} from "@/modules/self-check/service";
import { verifySelfCheckToken } from "@/modules/self-check/token";
import { TEST_NOW, fakeDb, refusal } from "../support/self-check-fakes";
import type { SelfCheck } from "@prisma/client";

/**
 * Заполненная ловушка: запись есть, кейса и трат нет, бот видит успех.
 *
 * Скрытое поле `company` человек не видит и не заполняет. Запись нужна —
 * она считается в лимит адреса и остаётся следом; кейс — нет: список дел
 * принадлежит оператору, и мусору бота там не место. Ответ неотличим от
 * успешного, чтобы бот не подбирал обход, а платные шаги по такой записи
 * закрыты.
 */

const SECRET = "honeypot-test-secret-0123456789abcdef";

const body = {
  fullName: "Иванов Иван Иванович",
  birthDate: "1985-03-12",
  inn: "500301123458",
  consent: true,
  captchaToken: "captcha-token",
  company: "ООО Бот",
};

let seq = 0;

function create(db: unknown, form: Record<string, unknown>, env: Record<string, string> = {}, save = vi.fn()) {
  seq += 1;
  return createSelfCheck(
    { body: form, ip: "203.0.113.7", userAgent: "bot/1.0", cookieToken: null },
    {
      db: db as never,
      now: () => TEST_NOW,
      env: env as NodeJS.ProcessEnv,
      secret: SECRET,
      newId: () => `check-${seq}`,
      newPublicId: () => `public-${seq}-0123456789abcdefgh`,
      verifyCaptcha: async () => ({ verified: true as const }),
      saveSubjectProfile: save,
    }
  );
}

describe("ловушка", () => {
  it("запись BLOCKED без кейса, а ответ — как у успешного создания", async () => {
    const { db, state } = fakeDb();
    const save = vi.fn();
    const result = await create(db, body, {}, save);
    expect(result).toMatchObject({ kind: "created", status: "CREATED" });
    expect(state.cases).toHaveLength(0);
    expect(state.selfChecks).toHaveLength(1);
    expect(state.selfChecks[0]).toMatchObject({
      caseId: null,
      honeypotTripped: true,
      status: "BLOCKED",
      blockedReason: "CAPTCHA_FAILED",
    });
    expect(save).not.toHaveBeenCalled();
    if (result.kind !== "created") throw new Error("ожидалось создание");
    const payload = await verifySelfCheckToken(result.token, SECRET, TEST_NOW);
    expect(payload?.checkId).toBe(state.selfChecks[0]!.id);
  });

  it("в аудит — причина HONEYPOT, без кейса и без записи о создании", async () => {
    const { db, state } = fakeDb();
    await create(db, body);
    expect(state.audits.map((a) => a.action)).toEqual(["SELF_CHECK_BLOCKED"]);
    expect(state.audits[0]).toMatchObject({
      caseId: null,
      ipAddress: "203.0.113.7",
      metadata: { reason: "HONEYPOT" },
    });
  });

  it("строка ловушки считается в лимит адреса", async () => {
    const { db } = fakeDb();
    const env = { SELF_CHECK_IP_HOURLY_LIMIT: "1" };
    await create(db, body, env);
    const err = await refusal(create(db, { ...body, company: "", birthDate: "1986-01-01" }, env));
    expect(err).toMatchObject({ status: 429, details: { reason: "RATE_LIMITED" } });
  });

  it("по такой записи панель не собирается и решение не принимается", async () => {
    const { db, state } = fakeDb();
    await create(db, body);
    const check = state.selfChecks[0] as unknown as SelfCheck;
    const buildPanel = vi.fn();
    const deps = { db: db as never, now: () => TEST_NOW, env: {} as NodeJS.ProcessEnv, buildPanel: buildPanel as never };
    const panel = await refusal(buildSelfCheckPersona(check, { ip: "203.0.113.7" }, deps));
    expect(panel).toMatchObject({ status: 409, details: { reason: "SELF_CHECK_BLOCKED" } });
    const decision = await refusal(
      decideSelfCheckPersona(check, { decision: "APPROVED_WITHOUT_PERSONA" }, { ip: "203.0.113.7" }, deps)
    );
    expect(decision).toMatchObject({ status: 409, details: { reason: "SELF_CHECK_BLOCKED" } });
    expect(buildPanel).not.toHaveBeenCalled();
  });
});
