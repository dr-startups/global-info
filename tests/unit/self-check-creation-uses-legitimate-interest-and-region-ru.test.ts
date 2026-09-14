import { describe, expect, it, vi } from "vitest";
import { createSelfCheck } from "@/modules/self-check/service";
import { verifySelfCheckToken } from "@/modules/self-check/token";
import { CONSENT_VERSION } from "@/modules/site/content/legal";
import { subjectInputHash } from "@/modules/digital-profile/services/subject-persona-check";
import { DAY_MS, TEST_NOW, fakeDb, refusal } from "../support/self-check-fakes";

/**
 * Проверка с сайта заводит кейс так, чтобы полный сбор по нему прошёл.
 *
 * Решение заказчика 11.09: основание — законный интерес, согласие — получено,
 * регион — Россия; сам факт согласия посетителя (версия текста, время, адрес,
 * браузер) хранится в записи проверки. Автор кейса — проверка, а не «system»:
 * по нему кейс находится в списке «с сайта».
 */

const SECRET = "creation-test-secret-0123456789abcdef";

const body = {
  fullName: "Иванов Иван Иванович",
  birthDate: "1985-03-12",
  aliases: ["Ivanov Ivan"],
  consent: true,
  captchaToken: "captcha-token",
  company: "",
};

const request = { body, ip: "203.0.113.7", userAgent: "Mozilla/5.0 test", cookieToken: null };

function deps(db: unknown, extra: Record<string, unknown> = {}) {
  return {
    db: db as never,
    now: () => TEST_NOW,
    env: {} as NodeJS.ProcessEnv,
    secret: SECRET,
    newId: () => "check-new",
    newPublicId: () => "PUBLIC_new_0123456789abcd",
    verifyCaptcha: async () => ({ verified: true as const }),
    saveSubjectProfile: vi.fn(),
    ...extra,
  };
}

describe("кейс проверки с сайта", () => {
  it("заводится с законным интересом, полученным согласием и регионом RU", async () => {
    const { db, state } = fakeDb();
    const result = await createSelfCheck(request, deps(db));
    expect(result.kind).toBe("created");
    expect(state.cases).toHaveLength(1);
    expect(state.cases[0]).toMatchObject({
      lawfulBasis: "LEGITIMATE_INTEREST",
      consentStatus: "OBTAINED",
      targetRegions: ["RU"],
      notes: "Самопроверка с сайта",
      createdBy: "self-check:check-new",
      status: "DRAFT",
    });
    const subject = state.cases[0]!.subject as { fullName: string; aliases: string[]; dateOfBirth: Date };
    expect(subject.fullName).toBe("Иванов Иван Иванович");
    expect(subject.aliases).toEqual(["Ivanov Ivan"]);
    expect(subject.dateOfBirth.toISOString().slice(0, 10)).toBe("1985-03-12");
  });

  it("аудит кейса и проверки подписан проверкой, у проверки — адрес посетителя", async () => {
    const { db, state } = fakeDb();
    await createSelfCheck(request, deps(db));
    const caseCreated = state.audits.find((a) => a.action === "CASE_CREATED");
    expect(caseCreated).toMatchObject({ actorId: "self-check:check-new", caseId: state.cases[0]!.id });
    const created = state.audits.find((a) => a.action === "SELF_CHECK_CREATED");
    expect(created).toMatchObject({
      actorId: "self-check:check-new",
      caseId: state.cases[0]!.id,
      ipAddress: "203.0.113.7",
      metadata: { publicId: "PUBLIC_new_0123456789abcd", ipHash: state.selfChecks[0]!.ipHash },
    });
  });
});

describe("запись проверки", () => {
  it("хранит доказательство согласия и срок хранения", async () => {
    const { db, state } = fakeDb();
    await createSelfCheck(request, deps(db));
    const row = state.selfChecks[0]!;
    expect(row).toMatchObject({
      id: "check-new",
      publicId: "PUBLIC_new_0123456789abcd",
      caseId: state.cases[0]!.id,
      status: "CREATED",
      consentVersion: CONSENT_VERSION,
      ip: "203.0.113.7",
      userAgent: "Mozilla/5.0 test",
      honeypotTripped: false,
      leadStatus: "NONE",
    });
    expect(row.consentAt).toEqual(TEST_NOW);
    expect(row.createdAt).toEqual(TEST_NOW);
    expect(row.expiresAt).toEqual(new Date(TEST_NOW.getTime() + 30 * DAY_MS));
    expect(row.captchaVerifiedAt).toEqual(TEST_NOW);
    expect(row.inputJson).toMatchObject({
      fullName: "Иванов Иван Иванович",
      birthDate: "1985-03-12",
      aliases: ["Ivanov Ivan"],
    });
  });

  it("адрес и субъект хешируются с солью: по хешу их не подобрать", async () => {
    const { db, state } = fakeDb();
    await createSelfCheck(request, deps(db));
    const row = state.selfChecks[0]!;
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(row.subjectHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(row.subjectHash).not.toBe(
      subjectInputHash({ fullName: body.fullName, aliases: [], dateOfBirth: body.birthDate })
    );
    const other = fakeDb();
    await createSelfCheck(request, deps(other.db, { secret: "another-secret-0123456789abcdef" }));
    expect(other.state.selfChecks[0]!.ipHash).not.toBe(row.ipHash);
  });

  it("капча пропущена без ключа — время подтверждения не записывается", async () => {
    const { db, state } = fakeDb();
    await createSelfCheck(
      request,
      deps(db, { verifyCaptcha: async () => ({ verified: false, skipped: "NOT_CONFIGURED" }) })
    );
    expect(state.selfChecks[0]!.captchaVerifiedAt).toBeNull();
  });

  it("ответ несёт токен именно этой проверки", async () => {
    const { db } = fakeDb();
    const result = await createSelfCheck(request, deps(db));
    if (result.kind !== "created") throw new Error("ожидалось создание");
    expect(result.publicId).toBe("PUBLIC_new_0123456789abcd");
    const payload = await verifySelfCheckToken(result.token, SECRET, TEST_NOW);
    expect(payload?.checkId).toBe("check-new");
  });

  it("publicId по умолчанию — не короче 22 знаков и не повторяется", async () => {
    const { db, state } = fakeDb();
    const d = deps(db);
    const { newPublicId: _p, newId: _i, ...rest } = d;
    await createSelfCheck(request, rest);
    await createSelfCheck({ ...request, body: { ...body, birthDate: "1986-03-12" } }, rest);
    const [first, second] = state.selfChecks.map((r) => String(r.publicId));
    expect(first!.length).toBeGreaterThanOrEqual(22);
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first).not.toBe(second);
    expect(state.selfChecks[0]!.id).not.toBe(state.selfChecks[1]!.id);
  });
});

describe("отказы до создания", () => {
  it("форма без даты рождения — 400 с полем, ни кейса, ни записи", async () => {
    const { db, state } = fakeDb();
    const err = await refusal(createSelfCheck({ ...request, body: { ...body, birthDate: "" } }, deps(db)));
    expect(err).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
    expect(err.details?.fieldErrors?.birthDate).toBeDefined();
    expect(state.cases).toHaveLength(0);
    expect(state.selfChecks).toHaveLength(0);
  });

  it("капча отказала — ни кейса, ни записи", async () => {
    const { db, state } = fakeDb();
    const { ValidationError } = await import("@/modules/digital-profile/http/errors");
    const err = await refusal(
      createSelfCheck(
        request,
        deps(db, {
          verifyCaptcha: async () => {
            throw new ValidationError("captcha failed", { reason: "CAPTCHA_FAILED" });
          },
        })
      )
    );
    expect(err.details?.reason).toBe("CAPTCHA_FAILED");
    expect(state.cases).toHaveLength(0);
    expect(state.selfChecks).toHaveLength(0);
  });
});
