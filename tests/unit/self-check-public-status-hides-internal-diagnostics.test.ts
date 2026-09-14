import { describe, expect, it } from "vitest";
import { publicSelfCheckStatus } from "@/modules/self-check/public-dto";
import { personaCheckRow, selfCheckRow } from "../support/self-check-fakes";

/**
 * Статус проверки для посетителя — только то, что рисует экран.
 *
 * Запись проверки хранит доказательство согласия (адрес, браузер), хеши,
 * снимок формы с ИНН и местом работы, контакты заявки и связь с кейсом. Экрану
 * нужны имя и дата для заголовка, решение по персоне, признак заявки и причина
 * отказа. Статус операторского конвейера отдаёт диагностику — её наружу не
 * пускаем.
 */

const check = selfCheckRow({
  status: "PERSONA_DECIDED",
  jobId: "job-secret-1",
  captchaVerifiedAt: new Date("2026-09-14T10:00:00Z"),
  leadName: "Иван",
  leadPhone: "+79001112233",
  leadEmail: "ivan@example.ru",
  leadMessage: "перезвоните вечером",
  leadAt: new Date("2026-09-14T10:10:00Z"),
  leadStatus: "NEW",
});

const decided = personaCheckRow({
  decision: "APPROVED_WITHOUT_PERSONA",
  decidedAt: new Date("2026-09-14T10:05:00Z"),
  personasJson: {
    subjectFullName: "Иванов Иван Иванович",
    subjectDateOfBirth: "1985-03-12",
    cards: [{ cardId: "a" }, { cardId: "b" }],
    serpRows: [],
    sources: [],
    fetchStatus: "SUCCESS",
    errorCode: null,
  },
});

describe("проекция статуса", () => {
  it("экран получает заголовок, персону, заявку и сроки", () => {
    const out = publicSelfCheckStatus(check, decided);
    expect(out).toMatchObject({
      publicId: check.publicId,
      status: "PERSONA_DECIDED",
      createdAt: check.createdAt,
      expiresAt: check.expiresAt,
      subject: { fullName: "Иванов Иван Иванович", birthDate: "1985-03-12" },
      persona: { decided: true, cardsCount: 2 },
      run: null,
      result: null,
      lead: { submitted: true, at: new Date("2026-09-14T10:10:00Z") },
      blocked: null,
    });
  });

  it("внутреннего нет: ни связей, ни адреса, ни хешей, ни формы, ни контактов", () => {
    const out = publicSelfCheckStatus(check, decided) as unknown as Record<string, unknown>;
    for (const key of ["id", "caseId", "ip", "ipHash", "subjectHash", "userAgent", "inputJson", "jobId", "leadStatus", "honeypotTripped"]) {
      expect(out, key).not.toHaveProperty(key);
    }
    const json = JSON.stringify(out);
    for (const leak of [
      "check-1",
      "case-1",
      "203.0.113.7",
      "Mozilla",
      "iphash",
      "subjecthash",
      "job-secret-1",
      "+79001112233",
      "ivan@example.ru",
      "перезвоните",
      "500301123458",
      "Ромашка",
      "romashka.ru",
      "self-check:",
    ]) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it("панели ещё нет — персона не решена и карточек ноль", () => {
    const out = publicSelfCheckStatus(selfCheckRow({ status: "CREATED" }), null);
    expect(out.persona).toEqual({ decided: false, cardsCount: 0 });
  });

  it("собранная, но нерешённая панель — не решение", () => {
    const out = publicSelfCheckStatus(selfCheckRow({ status: "PERSONA_PENDING" }), personaCheckRow());
    expect(out.persona.decided).toBe(false);
  });

  it("заявки нет — не отправлена и без времени", () => {
    expect(publicSelfCheckStatus(selfCheckRow(), null).lead).toEqual({ submitted: false, at: null });
  });

  it("отказ отдаёт причину и человеческий текст", () => {
    const limited = publicSelfCheckStatus(selfCheckRow({ status: "BLOCKED", blockedReason: "RATE_LIMITED" }), null);
    expect(limited.blocked?.reason).toBe("RATE_LIMITED");
    expect(limited.blocked?.message).toMatch(/Попробуйте завтра/u);
    const robot = publicSelfCheckStatus(selfCheckRow({ status: "BLOCKED", blockedReason: "CAPTCHA_FAILED" }), null);
    expect(robot.blocked?.message).toMatch(/не робот/u);
    const unknown = publicSelfCheckStatus(selfCheckRow({ status: "FAILED", blockedReason: null }), null);
    expect(unknown.blocked?.message.length).toBeGreaterThan(0);
  });
});
