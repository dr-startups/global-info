import { describe, expect, it } from "vitest";
import { checkFormErrors, EMPTY_CHECK_FORM, innInput, type CheckFormValues } from "@/modules/site/check/form";
import { SelfCheckFormSchema } from "@/modules/self-check/schemas";

/**
 * Поле ИНН: в него попадают только цифры и не больше двенадцати, а отказ
 * называет, что именно не так.
 *
 * Контрольная сумма ИНН не проверяется — решение владельца 20.09.2026. Цена
 * решения названа ему прямо: номер идёт в сильные признаки различения
 * однофамильцев, и опечатка в цифре может привести человеку чужой материал.
 * Поле отвечает только за длину и состав: 10 или 12 цифр, и ничего кроме цифр.
 */

/** Тело ручки с заполненными обязательными полями — чтобы про ИНН спрашивать схему напрямую. */
const checkFormPayloadStub = {
  fullName: "Проверкин Тест Этапович",
  birthDate: "1985-03-12",
  aliases: [],
  consent: true as const,
};

const form = (over: Partial<CheckFormValues>): CheckFormValues => ({
  ...EMPTY_CHECK_FORM,
  fullName: "Проверкин Тест Этапович",
  birthDate: "12.03.1985",
  consent: true,
  ...over,
});

describe("в поле попадают только цифры", () => {
  it("пробелы и буквы из вставленного номера убираются", () => {
    expect(innInput("7707 083893")).toBe("7707083893");
    expect(innInput("ИНН 7707083893")).toBe("7707083893");
    expect(innInput("abc")).toBe("");
  });

  it("длиннее двенадцати не набрать", () => {
    expect(innInput("1234567890123456")).toBe("123456789012");
  });
});

describe("отказ называет, что не так", () => {
  it("номер не дописан — так и сказано", () => {
    expect(checkFormErrors(form({ inn: "77070838" })).inn).toBe(
      "ИНН не дописан: у компании в нём 10 цифр, у человека — 12."
    );
  });

  it("одиннадцать цифр — такого ИНН не бывает", () => {
    expect(checkFormErrors(form({ inn: "77070838931" })).inn).toBe("В ИНН 10 или 12 цифр — проверьте номер.");
  });

  it("верная длина принимается, даже если контрольная цифра не сходится", () => {
    // 7707083892 — та же десятка с изменённой последней цифрой: контрольный разряд
    // не сходится, но правило проекта с 20.09.2026 смотрит только на длину
    expect(checkFormErrors(form({ inn: "7707083892" })).inn).toBeUndefined();
    expect(SelfCheckFormSchema.safeParse({ ...checkFormPayloadStub, inn: "7707083892" }).success).toBe(true);
  });

  it("настоящий номер ошибок не даёт — ни у компании, ни у человека", () => {
    expect(checkFormErrors(form({ inn: "7707083893" })).inn).toBeUndefined();
    expect(checkFormErrors(form({ inn: "500100732259" })).inn).toBeUndefined();
  });

  it("пустое поле необязательно — отказа нет", () => {
    expect(checkFormErrors(form({ inn: "" })).inn).toBeUndefined();
  });
});
