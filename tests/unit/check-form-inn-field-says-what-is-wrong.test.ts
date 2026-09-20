import { describe, expect, it } from "vitest";
import { checkFormErrors, EMPTY_CHECK_FORM, innInput, type CheckFormValues } from "@/modules/site/check/form";
import { isValidInn } from "@/modules/self-check/inn";

/**
 * Поле ИНН: в него попадают только цифры и не больше двенадцати, а отказ
 * называет, что именно не так.
 *
 * До 20.09.2026 поле принимало что угодно, а на всё отвечало одной строкой про
 * «10 или 12 цифр и контрольную сумму»: номер, скопированный с пробелом, и
 * недописанный номер выглядели одинаково неправильными, и человек не понимал,
 * что исправлять.
 */

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

  it("длина верная, а сумма не сходится — говорим именно об этом", () => {
    expect(isValidInn("7707083892")).toBe(false);
    expect(checkFormErrors(form({ inn: "7707083892" })).inn).toBe("Проверьте ИНН: контрольная цифра не сходится.");
  });

  it("настоящий номер ошибок не даёт — ни у компании, ни у человека", () => {
    expect(checkFormErrors(form({ inn: "7707083893" })).inn).toBeUndefined();
    expect(checkFormErrors(form({ inn: "500100732259" })).inn).toBeUndefined();
  });

  it("пустое поле необязательно — отказа нет", () => {
    expect(checkFormErrors(form({ inn: "" })).inn).toBeUndefined();
  });
});
