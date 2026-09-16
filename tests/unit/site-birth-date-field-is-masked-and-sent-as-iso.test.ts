import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SelfCheckFormSchema } from "@/modules/self-check/schemas";
import {
  BIRTH_DATE_INCOMPLETE_MESSAGE,
  birthDateToIso,
  caretAfterDigits,
  maskBirthDate,
} from "@/modules/site/check/birth-date";
import { EMPTY_CHECK_FORM, checkFormErrors, checkFormPayload, checkFormProgress, type CheckFormValues } from "@/modules/site/check/form";

/**
 * Дата рождения на сайте — текстовое поле с маской «дд.мм.гггг», а не календарь
 * браузера (решение владельца 16.09.2026: календарь не стилизуется, а на Android
 * открывается на сегодняшнем дне, и до года рождения приходится листать).
 *
 * В поле живёт то, что видит человек; в тело запроса уходит прежний «ГГГГ-ММ-ДД».
 * Перевод — в одном месте, при сборке тела: форма проверяет ровно то, что уйдёт на
 * сервер, и текст ошибки у поля остаётся текстом схемы ручки.
 */

const form = (over: Partial<CheckFormValues>): CheckFormValues => ({
  ...EMPTY_CHECK_FORM,
  fullName: "Проверкин Тест Этапович",
  consent: true,
  ...over,
});

describe("маска дд.мм.гггг", () => {
  it("точки ставятся сами и только перед следующей группой — стирание не застревает на точке", () => {
    expect(maskBirthDate("")).toBe("");
    expect(maskBirthDate("1")).toBe("1");
    expect(maskBirthDate("12")).toBe("12");
    expect(maskBirthDate("123")).toBe("12.3");
    expect(maskBirthDate("1203")).toBe("12.03");
    expect(maskBirthDate("12.03.")).toBe("12.03");
    expect(maskBirthDate("12031985")).toBe("12.03.1985");
  });

  it("лишнее отбрасывается: буквы, пробелы, девятая цифра", () => {
    expect(maskBirthDate("12a03 б1985")).toBe("12.03.1985");
    expect(maskBirthDate("12.03.19856")).toBe("12.03.1985");
  });

  it("вставка и автозаполнение в другом виде приводятся к маске", () => {
    expect(maskBirthDate("1985-03-12")).toBe("12.03.1985");
    expect(maskBirthDate(" 1985-03-12 ")).toBe("12.03.1985");
    expect(maskBirthDate("12/03/1985")).toBe("12.03.1985");
    expect(maskBirthDate("12-03-1985")).toBe("12.03.1985");
  });

  it("курсор встаёт после той же цифры, что и до маски", () => {
    expect(caretAfterDigits("12.03.1985", 0)).toBe(0);
    expect(caretAfterDigits("12.03.1985", 2)).toBe(2);
    expect(caretAfterDigits("12.3", 3)).toBe(4);
    expect(caretAfterDigits("12.03.1985", 4)).toBe(5);
    expect(caretAfterDigits("12.03.1985", 8)).toBe(10);
    expect(caretAfterDigits("12.03", 9)).toBe(5);
  });

  it("в ГГГГ-ММ-ДД переводится только полная дата", () => {
    expect(birthDateToIso("12.03.1985")).toBe("1985-03-12");
    expect(birthDateToIso(" 12.03.1985 ")).toBe("1985-03-12");
    expect(birthDateToIso("12.03.198")).toBeNull();
    expect(birthDateToIso("")).toBeNull();
    expect(birthDateToIso("1985-03-12")).toBeNull();
  });
});

describe("форма с маской", () => {
  it("в тело запроса уходит ГГГГ-ММ-ДД, и сервер его принимает", () => {
    const values = form({ birthDate: "12.03.1985" });
    expect(checkFormErrors(values)).toEqual({});
    const payload = checkFormPayload(values);
    expect(payload.birthDate).toBe("1985-03-12");
    expect(SelfCheckFormSchema.safeParse(payload).success).toBe(true);
  });

  it("несуществующая дата и возраст — текстом схемы ручки, а не своим", () => {
    expect(checkFormErrors(form({ birthDate: "31.02.1985" })).birthDate).toBe("Такой даты нет в календаре.");
    const future = new Date();
    const y = future.getUTCFullYear() + 1;
    expect(checkFormErrors(form({ birthDate: `01.01.${y}` })).birthDate).toBe("Дата рождения не может быть в будущем.");
  });

  it("пустое поле — «укажите дату», неполное — своя строка сайта про формат маски", () => {
    expect(checkFormErrors(form({ birthDate: "" })).birthDate).toBe("Укажите дату рождения.");
    expect(checkFormErrors(form({ birthDate: "12.03.19" })).birthDate).toBe(BIRTH_DATE_INCOMPLETE_MESSAGE);
    expect(BIRTH_DATE_INCOMPLETE_MESSAGE).toBe("Введите дату полностью: дд.мм.гггг.");
  });

  it("шкала заполнения считает дату только полной", () => {
    expect(checkFormProgress(form({ birthDate: "12.03", consent: false })).filled).toBe(1);
    expect(checkFormProgress(form({ birthDate: "12.03.1985", consent: false })).filled).toBe(2);
  });

  it("у поля нет type=date: текст, цифровая клавиатура, маска из общего модуля", () => {
    const text = readFileSync(join(process.cwd(), "src/modules/site/components/CheckForm.tsx"), "utf8");
    expect(text).not.toMatch(/type:\s*"date"/u);
    expect(text).toMatch(/id="birth-date"[\s\S]{0,400}?inputMode:\s*"numeric"/u);
    expect(text).toContain("@/modules/site/check/birth-date");
  });
});
