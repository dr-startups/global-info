import { describe, expect, it } from "vitest";
import { CreateDigitalProfileCaseSchema } from "@/modules/digital-profile/validation/case-schemas";

/**
 * Дело без даты рождения не заводится.
 *
 * Дата рождения — самый сильный признак субъекта и единственный, который
 * работает в обе стороны: подтверждает свой материал и опровергает чужой. Без
 * неё ворота персоны закрыты (`SUBJECT_ANCHORS_MISSING`), то есть платный сбор
 * всё равно не начнётся, — а узнавать об этом на кнопке «Собрать» поздно, дело
 * к тому моменту уже заведено с неполными данными.
 *
 * Прогон DPA-2026-0049 («Егоров Алексей Евгеньевич») был заведён без неё.
 */

const valid = {
  fullName: "Егоров Алексей Евгеньевич",
  lawfulBasis: "LEGITIMATE_INTEREST",
  consentStatus: "NOT_REQUIRED",
};

describe("дата рождения в карточке дела", () => {
  it("дата есть — дело заводится", () => {
    const parsed = CreateDigitalProfileCaseSchema.safeParse({ ...valid, birthDate: "1977-11-30" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.birthDate?.toISOString().slice(0, 10)).toBe("1977-11-30");
  });

  it("даты нет — отказ говорит, зачем она", () => {
    const parsed = CreateDigitalProfileCaseSchema.safeParse(valid);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toMatch(/дат[уы] рождения/u);
  });

  it("пустая строка — тот же отказ, а не «дата не указана»", () => {
    expect(CreateDigitalProfileCaseSchema.safeParse({ ...valid, birthDate: "" }).success).toBe(false);
  });

  it("непонятная дата остаётся непонятной датой", () => {
    const parsed = CreateDigitalProfileCaseSchema.safeParse({ ...valid, birthDate: "тридцатое" });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain("Invalid date");
  });
});
