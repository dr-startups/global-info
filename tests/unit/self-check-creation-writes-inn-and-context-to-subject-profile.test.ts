import { describe, expect, it, vi } from "vitest";
import { createSelfCheck } from "@/modules/self-check/service";
import { TEST_NOW, fakeDb, type FakeState } from "../support/self-check-fakes";

/**
 * Необязательные признаки формы попадают в профиль субъекта.
 *
 * Профиль читает классификация собранного материала: ИНН — известный
 * идентификатор, место работы, должность, город и сайт — слова контекста,
 * которые отличают человека от тёзки. Профиль — файл в хранилище, а не строка
 * базы, поэтому пишется последним внутри транзакции: не записался — нет ни
 * кейса, ни проверки, и посетитель просто повторяет отправку.
 */

const SECRET = "profile-test-secret-0123456789abcdef";

const body = {
  fullName: "Иванов Иван Иванович",
  birthDate: "1985-03-12",
  aliases: ["Ivanov Ivan"],
  consent: true,
  captchaToken: "captcha-token",
};

function run(db: unknown, save: (...args: unknown[]) => unknown, form: Record<string, unknown>) {
  return createSelfCheck(
    { body: { ...body, ...form }, ip: "203.0.113.7", userAgent: "ua", cookieToken: null },
    {
      db: db as never,
      now: () => TEST_NOW,
      env: {} as NodeJS.ProcessEnv,
      secret: SECRET,
      verifyCaptcha: async () => ({ verified: true as const }),
      saveSubjectProfile: save as never,
    }
  );
}

type SaveInput = {
  caseId: string;
  subjectName: string;
  subjectAliases: string[];
  edits: { inn?: string[]; contextIdentifiers?: string[] };
};

describe("профиль субъекта из формы", () => {
  it("ИНН — в идентификаторы; место работы, должность, город и домен сайта — в контекст", async () => {
    const { db, state } = fakeDb();
    const save = vi.fn();
    await run(db, save, {
      city: "Москва",
      inn: "500301123458",
      employer: "ООО «Ромашка»",
      position: "Финансовый директор",
      website: "https://www.romashka.ru/team",
    });
    expect(save).toHaveBeenCalledTimes(1);
    const input = save.mock.calls[0]![0] as SaveInput;
    expect(input).toMatchObject({
      caseId: state.cases[0]!.id,
      subjectName: "Иванов Иван Иванович",
      subjectAliases: ["Ivanov Ivan"],
      edits: { inn: ["500301123458"] },
    });
    expect(input.edits.contextIdentifiers).toHaveLength(4);
    expect(input.edits.contextIdentifiers).toEqual(
      expect.arrayContaining(["ООО «Ромашка»", "Финансовый директор", "Москва", "romashka.ru"])
    );
  });

  it("без признаков профиль не пишется", async () => {
    const { db } = fakeDb();
    const save = vi.fn();
    await run(db, save, {});
    expect(save).not.toHaveBeenCalled();
  });

  it("только ИНН — контекст не трогается, а не затирается пустым списком", async () => {
    const { db } = fakeDb();
    const save = vi.fn();
    await run(db, save, { inn: "7707083893" });
    const input = save.mock.calls[0]![0] as SaveInput;
    expect(input.edits.inn).toEqual(["7707083893"]);
    expect(input.edits.contextIdentifiers).toBeUndefined();
  });

  it("профиль пишется, когда кейс уже заведён в той же транзакции", async () => {
    const { db, state } = fakeDb();
    let seen: Pick<FakeState, "cases" | "selfChecks"> | null = null;
    await run(
      db,
      () => {
        seen = { cases: [...state.cases], selfChecks: [...state.selfChecks] };
      },
      { city: "Тверь" }
    );
    expect(seen!.cases).toHaveLength(1);
    expect(seen!.selfChecks).toHaveLength(1);
  });

  it("файл профиля не записался — нет ни кейса, ни проверки, ни аудита", async () => {
    const { db, state } = fakeDb();
    const save = vi.fn(() => {
      throw new Error("EACCES: storage is read-only");
    });
    await expect(run(db, save, { employer: "ООО «Ромашка»" })).rejects.toThrow(/EACCES/u);
    expect(state.cases).toHaveLength(0);
    expect(state.selfChecks).toHaveLength(0);
    expect(state.audits).toHaveLength(0);
  });
});
