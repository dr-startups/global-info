import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelfCheckFormSchema, normalizeWebsite } from "@/modules/self-check/schemas";

/**
 * Форма проверки на сайте: ФИО, дата рождения и согласие обязательны.
 *
 * Дата рождения — признак, по которому санкционная карточка человека
 * отличается от карточки полного тёзки, поэтому без неё проверка не
 * создаётся. Согласие — основание обработки: без галочки данные не
 * принимаются вовсе. Необязательные признаки из свёрнутого блока приходят
 * пустыми строками, и пустая строка значением не считается.
 *
 * Схема общая для сервера и формы в браузере, поэтому тексты отказов — те, что
 * увидит посетитель у поля.
 */

const valid = {
  fullName: "Иванов Иван Иванович",
  birthDate: "1985-03-12",
  consent: true,
  captchaToken: "token",
  company: "",
};

type Input = Record<string, unknown>;

const fieldErrors = (input: Input): Record<string, string[] | undefined> => {
  const parsed = SelfCheckFormSchema.safeParse(input);
  return parsed.success ? {} : parsed.error.flatten().fieldErrors;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("обязательные поля", () => {
  it("ФИО, дата рождения и согласие — достаточно", () => {
    const parsed = SelfCheckFormSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      fullName: "Иванов Иван Иванович",
      birthDate: "1985-03-12",
      consent: true,
      aliases: [],
    });
  });

  it.each([
    ["поля нет", undefined],
    ["пустая строка", ""],
    ["null", null],
  ])("без даты рождения проверка не создаётся: %s", (_label, birthDate) => {
    expect(fieldErrors({ ...valid, birthDate }).birthDate).toEqual(["Укажите дату рождения."]);
  });

  it.each([
    ["галочка снята", false],
    ["поля нет", undefined],
    ["строка вместо отметки", "true"],
  ])("без согласия — отказ у поля согласия: %s", (_label, consent) => {
    expect(fieldErrors({ ...valid, consent }).consent).toEqual([
      "Для запуска проверки требуется согласие.",
    ]);
  });

  it("одно слово вместо ФИО — отказ, который называет отчество", () => {
    const errors = fieldErrors({ ...valid, fullName: "Иванов" });
    expect(errors.fullName?.join(" ")).toMatch(/отчество/u);
  });

  it("пробелы в ФИО схлопываются", () => {
    const parsed = SelfCheckFormSchema.parse({ ...valid, fullName: "  Иванов   Иван  Иванович " });
    expect(parsed.fullName).toBe("Иванов Иван Иванович");
  });
});

describe("дата рождения", () => {
  it.each([
    ["не ISO", "12.03.1985"],
    ["несуществующий день", "1985-02-30"],
    ["слово", "вчера"],
  ])("непонятная дата — отказ: %s", (_label, birthDate) => {
    expect(fieldErrors({ ...valid, birthDate }).birthDate).toBeDefined();
  });

  it("дата в будущем — отказ", () => {
    expect(fieldErrors({ ...valid, birthDate: "2027-01-01" }).birthDate).toBeDefined();
  });

  it("возраст от 14 до 110 лет включительно", () => {
    expect(fieldErrors({ ...valid, birthDate: "2012-09-14" }).birthDate).toBeUndefined();
    expect(fieldErrors({ ...valid, birthDate: "2012-09-15" }).birthDate).toBeDefined();
    expect(fieldErrors({ ...valid, birthDate: "1915-09-15" }).birthDate).toBeUndefined();
    expect(fieldErrors({ ...valid, birthDate: "1915-09-14" }).birthDate).toBeDefined();
  });
});

describe("необязательные признаки", () => {
  it("пустые строки из свёрнутого блока — не значения", () => {
    const parsed = SelfCheckFormSchema.parse({
      ...valid,
      city: "",
      inn: " ",
      employer: "",
      position: "",
      website: "",
    });
    expect(parsed.city).toBeUndefined();
    expect(parsed.inn).toBeUndefined();
    expect(parsed.employer).toBeUndefined();
    expect(parsed.position).toBeUndefined();
    expect(parsed.website).toBeUndefined();
  });

  it("ИНН принимается по длине: 10 или 12 цифр, контрольная сумма не проверяется", () => {
    // Решение владельца 20.09.2026. Цена названа: номер идёт в сильные признаки
    // различения однофамильцев, и опечатка в цифре теперь проходит.
    expect(fieldErrors({ ...valid, inn: "500301123458" }).inn).toBeUndefined();
    expect(fieldErrors({ ...valid, inn: "500301123459" }).inn).toBeUndefined();
    expect(fieldErrors({ ...valid, inn: "50030112345" }).inn).toEqual(["В ИНН 10 или 12 цифр — проверьте номер."]);
    expect(fieldErrors({ ...valid, inn: "50030112345a" }).inn).toEqual(["В ИНН 10 или 12 цифр — проверьте номер."]);
  });

  it("сайт сводится к домену: без схемы, www и пути", () => {
    const parsed = SelfCheckFormSchema.parse({
      ...valid,
      website: "https://www.Example.ru/about?x=1",
    });
    expect(parsed.website).toBe("example.ru");
    expect(normalizeWebsite("пример.рф/")).toBe("пример.рф");
    expect(fieldErrors({ ...valid, website: "не сайт" }).website).toBeDefined();
  });

  it("других написаний не больше десяти", () => {
    const aliases = Array.from({ length: 11 }, (_, i) => `Ivanov ${i}`);
    expect(fieldErrors({ ...valid, aliases }).aliases).toBeDefined();
    expect(fieldErrors({ ...valid, aliases: aliases.slice(0, 10) }).aliases).toBeUndefined();
  });

  it("длины полей ограничены", () => {
    expect(fieldErrors({ ...valid, city: "г".repeat(121) }).city).toBeDefined();
    expect(fieldErrors({ ...valid, employer: "р".repeat(161) }).employer).toBeDefined();
    expect(fieldErrors({ ...valid, position: "д".repeat(161) }).position).toBeDefined();
  });

  it("заполненную ловушку схема не отвергает: решение за сервером", () => {
    expect(SelfCheckFormSchema.safeParse({ ...valid, company: "ООО Бот" }).success).toBe(true);
  });
});
