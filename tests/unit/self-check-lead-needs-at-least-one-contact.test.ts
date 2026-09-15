import { describe, expect, it } from "vitest";
import { SelfCheckLeadSchema } from "@/modules/self-check/schemas";
import { submitSelfCheckLead } from "@/modules/self-check/service";
import { TEST_NOW, fakeDb, refusal, selfCheckRow } from "../support/self-check-fakes";

/**
 * Заявка принимается с именем и хотя бы одним способом связи.
 *
 * Макет даёт выбрать один способ — телефон, Telegram или email, — а ручка
 * принимает любой набор, в котором есть хотя бы один: заявка без контакта —
 * это лид, с которым менеджеру нечего делать. Писем и уведомлений в MVP нет,
 * поэтому заявка — только запись, которую менеджер увидит в карточке кейса.
 */

type Input = Record<string, unknown>;

const fieldErrors = (input: Input): Record<string, string[] | undefined> => {
  const parsed = SelfCheckLeadSchema.safeParse(input);
  return parsed.success ? {} : parsed.error.flatten().fieldErrors;
};

describe("форма заявки", () => {
  it.each([
    ["телефон", { phone: "+7 (900) 000-00-00" }],
    ["Telegram", { telegram: "@ivan_petrov" }],
    ["email", { email: "ivan@example.ru" }],
  ])("имя и один контакт — достаточно: %s", (_l, contact) => {
    expect(SelfCheckLeadSchema.safeParse({ name: "Иван", ...contact }).success).toBe(true);
  });

  it.each([
    ["контактов нет", { name: "Иван" }],
    ["все контакты пустые", { name: "Иван", phone: "", email: " ", telegram: "" }],
  ])("%s — отказ у поля контакта", (_l, input) => {
    expect(fieldErrors(input).contact).toEqual(["Укажите контакт выбранным способом."]);
  });

  it("без имени — отказ у имени", () => {
    expect(fieldErrors({ phone: "+7 900 000-00-00" }).name).toEqual(["Укажите, как к вам обращаться."]);
  });

  it("телефон — не меньше десяти цифр и без букв", () => {
    expect(fieldErrors({ name: "Иван", phone: "12345" }).phone).toBeDefined();
    expect(fieldErrors({ name: "Иван", phone: "+7 900 ABC-00-00" }).phone).toBeDefined();
  });

  it("email и Telegram проверяются по форме, Telegram — с @", () => {
    expect(fieldErrors({ name: "Иван", email: "ivan@" }).email).toBeDefined();
    expect(fieldErrors({ name: "Иван", telegram: "@ab" }).telegram).toBeDefined();
    expect(SelfCheckLeadSchema.parse({ name: "Иван", telegram: "ivan_petrov" }).telegram).toBe("@ivan_petrov");
  });

  it("удобное время — из вариантов макета", () => {
    expect(fieldErrors({ name: "Иван", phone: "+79000000000", preferredTime: "night" }).preferredTime).toBeDefined();
    for (const preferredTime of ["any", "morning", "day", "evening"]) {
      expect(SelfCheckLeadSchema.safeParse({ name: "Иван", phone: "+79000000000", preferredTime }).success).toBe(true);
    }
  });

  it("комментарий — не длиннее 2000 знаков", () => {
    expect(fieldErrors({ name: "Иван", phone: "+79000000000", message: "к".repeat(2001) }).message).toBeDefined();
  });
});

describe("приём заявки", () => {
  const body = { name: "Иван", phone: "+7 900 000-00-00", preferredTime: "evening", message: "Позвоните вечером" };
  const ctx = { ip: "203.0.113.7" };
  const deps = (db: unknown) => ({ db: db as never, now: () => TEST_NOW, env: {} as NodeJS.ProcessEnv });

  it("после результата заявка сохраняется, лид — новый", async () => {
    const check = selfCheckRow({ status: "DONE" });
    const { db, state } = fakeDb({ selfChecks: [check] });
    const out = await submitSelfCheckLead(check, body, ctx, deps(db));
    expect(out).toEqual({ leadAt: TEST_NOW });
    expect(state.selfChecks[0]).toMatchObject({
      leadName: "Иван",
      leadPhone: "+7 900 000-00-00",
      leadEmail: null,
      leadTelegram: null,
      leadPreferredTime: "evening",
      leadMessage: "Позвоните вечером",
      leadAt: TEST_NOW,
      leadStatus: "NEW",
      status: "DONE",
    });
  });

  it("аудит называет каналы, но не контакты", async () => {
    const check = selfCheckRow({ status: "DONE" });
    const { db, state } = fakeDb({ selfChecks: [check] });
    await submitSelfCheckLead(check, body, ctx, deps(db));
    const audit = state.audits.find((a) => a.action === "SELF_CHECK_LEAD");
    expect(audit).toMatchObject({
      caseId: "case-1",
      actorId: "self-check:check-1",
      ipAddress: "203.0.113.7",
      metadata: { channels: ["phone"], preferredTime: "evening" },
    });
    expect(JSON.stringify(audit)).not.toContain("900");
    expect(JSON.stringify(audit)).not.toContain("Позвоните");
  });

  it.each(["DONE", "FAILED", "BLOCKED"])("в статусе %s заявка принимается", async (status) => {
    const check = selfCheckRow({ status });
    const { db } = fakeDb({ selfChecks: [check] });
    await expect(submitSelfCheckLead(check, body, ctx, deps(db))).resolves.toEqual({ leadAt: TEST_NOW });
  });

  // `PERSONA_DECIDED` — проходное состояние с тех пор, как появился прогон:
  // посетитель из него идёт дальше, к результату или к отказу.
  it.each(["CREATED", "PERSONA_PENDING", "PERSONA_DECIDED", "RUNNING", "EXPIRED"])(
    "в статусе %s — 409 LEAD_NOT_APPLICABLE, запись не тронута",
    async (status) => {
      const check = selfCheckRow({ status });
      const { db, state } = fakeDb({ selfChecks: [check] });
      const err = await refusal(submitSelfCheckLead(check, body, ctx, deps(db)));
      expect(err).toMatchObject({ status: 409, code: "CONFLICT", details: { reason: "LEAD_NOT_APPLICABLE" } });
      expect(state.selfChecks[0]!.leadAt).toBeNull();
    }
  );

  it("проверка, пойманная ловушкой, заявку не принимает", async () => {
    const check = selfCheckRow({ status: "BLOCKED", honeypotTripped: true, caseId: null });
    const { db } = fakeDb({ selfChecks: [check] });
    const err = await refusal(submitSelfCheckLead(check, body, ctx, deps(db)));
    expect(err).toMatchObject({ status: 409, details: { reason: "LEAD_NOT_APPLICABLE" } });
  });

  it("без контакта — 400 с полем, запись не тронута", async () => {
    const check = selfCheckRow({ status: "DONE" });
    const { db, state } = fakeDb({ selfChecks: [check] });
    const err = await refusal(submitSelfCheckLead(check, { name: "Иван" }, ctx, deps(db)));
    expect(err).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(err.details?.fieldErrors?.contact).toBeDefined();
    expect(state.selfChecks[0]!.leadAt).toBeNull();
    expect(state.audits).toHaveLength(0);
  });

  it("повторная заявка заменяет контакты, но статус менеджера не сбрасывает", async () => {
    const check = selfCheckRow({
      status: "DONE",
      leadName: "Иван",
      leadPhone: "+79000000000",
      leadAt: new Date("2026-09-14T09:00:00Z"),
      leadStatus: "CONTACTED",
    });
    const { db, state } = fakeDb({ selfChecks: [check] });
    await submitSelfCheckLead(check, { name: "Иван", email: "ivan@example.ru" }, ctx, deps(db));
    expect(state.selfChecks[0]).toMatchObject({
      leadPhone: null,
      leadEmail: "ivan@example.ru",
      leadAt: TEST_NOW,
      leadStatus: "CONTACTED",
    });
  });
});
