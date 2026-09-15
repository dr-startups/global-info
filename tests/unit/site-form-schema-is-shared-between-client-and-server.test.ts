import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SelfCheckFormSchema, SelfCheckLeadSchema } from "@/modules/self-check/schemas";
import { normalizeError } from "@/modules/digital-profile/http/errors";
import {
  EMPTY_CHECK_FORM,
  EMPTY_LEAD_FORM,
  checkFormErrors,
  checkFormPayload,
  checkFormProgress,
  leadFormErrors,
  leadFormPayload,
  serverFieldErrors,
  type CheckFormValues,
  type LeadFormValues,
} from "@/modules/site/check/form";

/**
 * Форма в браузере проверяет поля той же схемой, что ручка создания.
 *
 * Своя проверка в браузере — второй ответ на вопрос «годятся ли поля»: она
 * разошлась бы с сервером, и посетитель видел бы у поля одно, а после отправки —
 * другое. Поэтому текст у поля до отправки и текст из `400` сервера — один и тот
 * же текст одной схемы.
 */

const root = process.cwd();
const source = (path: string) => readFileSync(join(root, path), "utf8");
const imports = (text: string) => [...text.matchAll(/from\s+"([^"]+)"/gu)].map((m) => m[1]);

function serverErrors(schema: typeof SelfCheckFormSchema | typeof SelfCheckLeadSchema, payload: unknown) {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return {};
  const details = normalizeError(parsed.error).details as { fieldErrors: Record<string, string[]> };
  return serverFieldErrors(details.fieldErrors);
}

const form = (over: Partial<CheckFormValues>): CheckFormValues => ({ ...EMPTY_CHECK_FORM, ...over });
const lead = (over: Partial<LeadFormValues>): LeadFormValues => ({ ...EMPTY_LEAD_FORM, ...over });

describe("форма проверки", () => {
  it("ошибки у полей — те же, что в ответе 400 сервера", () => {
    const values = form({ fullName: "Иванов", birthDate: "", inn: "77070838", website: "не сайт", consent: false });
    const errors = checkFormErrors(values);
    expect(errors).toEqual(serverErrors(SelfCheckFormSchema, checkFormPayload(values)));
    expect(errors).toMatchObject({
      fullName: "Укажите фамилию и имя, а если есть — отчество.",
      birthDate: "Укажите дату рождения.",
      inn: "ИНН должен содержать 10 или 12 цифр и проходить проверку контрольной суммы.",
      website: "Укажите адрес сайта, например example.ru.",
      consent: "Для запуска проверки требуется согласие.",
    });
  });

  it("заполненная форма ошибок не даёт, и сервер принимает её тело", () => {
    const values = form({
      fullName: "Проверкин Тест Этапович",
      birthDate: "1985-03-12",
      aliases: "Proverkin Test,  Иванова-Проверкина , ",
      consent: true,
    });
    expect(checkFormErrors(values)).toEqual({});
    const payload = checkFormPayload(values, "captcha-token");
    expect(payload).toMatchObject({
      fullName: "Проверкин Тест Этапович",
      aliases: ["Proverkin Test", "Иванова-Проверкина"],
      consent: true,
      captchaToken: "captcha-token",
      company: "",
    });
    expect(SelfCheckFormSchema.safeParse(payload).success).toBe(true);
  });

  it("шкала заполнения: два обязательных поля и согласие — три трети хода", () => {
    expect(checkFormProgress(EMPTY_CHECK_FORM)).toEqual({ filled: 0, meter: 0 });
    expect(checkFormProgress(form({ fullName: "Проверкин Тест" }))).toEqual({ filled: 1, meter: 33 });
    expect(checkFormProgress(form({ fullName: "Проверкин Тест", birthDate: "1985-03-12" }))).toEqual({
      filled: 2,
      meter: 67,
    });
    expect(
      checkFormProgress(form({ fullName: "Проверкин Тест", birthDate: "1985-03-12", consent: true }))
    ).toEqual({ filled: 2, meter: 100 });
    expect(checkFormProgress(form({ fullName: "   " }))).toEqual({ filled: 0, meter: 0 });
  });
});

describe("заявка", () => {
  it("уходит только контакт выбранного способа — поле скрытого способа не отправляется", () => {
    const values = lead({ name: "Тест", channel: "phone", phone: "+7 900 000-00-00", telegram: "@hidden_name" });
    const payload = leadFormPayload(values);
    expect(payload).toEqual({ name: "Тест", phone: "+7 900 000-00-00", preferredTime: "any" });
    expect(SelfCheckLeadSchema.safeParse(payload).success).toBe(true);
  });

  it("без имени и контакта — те же ошибки, что у сервера", () => {
    const values = lead({ channel: "email", telegram: "@hidden_name" });
    const errors = leadFormErrors(values);
    expect(errors).toEqual(serverErrors(SelfCheckLeadSchema, leadFormPayload(values)));
    expect(errors).toMatchObject({
      name: "Укажите, как к вам обращаться.",
      contact: "Укажите контакт выбранным способом.",
    });
  });

  it("неверный Telegram — текст схемы у поля способа", () => {
    const values = lead({ name: "Тест", channel: "telegram", telegram: "abc" });
    expect(leadFormErrors(values)).toEqual(serverErrors(SelfCheckLeadSchema, leadFormPayload(values)));
    expect(leadFormErrors(values).telegram).toBe("Имя в Telegram — от 5 до 32 латинских букв, цифр и «_».");
  });

  it("комментарий уходит, пустой — нет", () => {
    expect(leadFormPayload(lead({ name: "Тест", channel: "email", email: "t@example.ru", message: "Позвоните" }))).toEqual(
      { name: "Тест", email: "t@example.ru", preferredTime: "any", message: "Позвоните" }
    );
  });
});

describe("схема одна", () => {
  it("модуль формы берёт схемы у ручек, а компоненты — у модуля формы", () => {
    expect(imports(source("src/modules/site/check/form.ts"))).toContain("@/modules/self-check/schemas");
    for (const file of ["src/modules/site/components/CheckForm.tsx", "src/modules/site/components/check/LeadScreen.tsx"]) {
      const text = source(file);
      expect(imports(text), file).toContain("@/modules/site/check/form");
      expect(text, `${file}: своя схема в компоненте`).not.toMatch(/\bz\.(object|string)\(/u);
      expect(imports(text), file).not.toContain("zod");
    }
  });

  it("схема собирается в браузере: ни базы, ни серверных модулей", () => {
    expect(imports(source("src/modules/self-check/schemas.ts")).sort()).toEqual(["./inn", "zod"]);
    expect(imports(source("src/modules/self-check/inn.ts"))).toEqual([]);
  });
});
