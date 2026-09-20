import { describe, expect, it } from "vitest";
import {
  DEFAULT_PHONE_COUNTRY,
  OTHER_PHONE_COUNTRY,
  PHONE_COUNTRIES,
  phoneCountry,
  phoneComplete,
  phoneE164,
  phoneMasked,
} from "@/modules/site/check/phone";
import { EMPTY_LEAD_FORM, leadFormErrors, leadFormPayload, type LeadFormValues } from "@/modules/site/check/form";
import { SelfCheckLeadSchema } from "@/modules/self-check/schemas";

/**
 * Телефон в заявке набирается по маске выбранной страны (решение владельца
 * 20.09.2026): раньше поле принимало любую строку, а отказ приходил только
 * после «Отправить заявку», и мусор до этого выглядел принятым.
 */

const lead = (over: Partial<LeadFormValues>): LeadFormValues => ({ ...EMPTY_LEAD_FORM, name: "Антон", ...over });

describe("справочник стран", () => {
  it("по умолчанию Россия, «другая страна» — последняя в списке", () => {
    expect(DEFAULT_PHONE_COUNTRY).toBe("RU");
    expect(PHONE_COUNTRIES[0]!.id).toBe("RU");
    expect(PHONE_COUNTRIES[PHONE_COUNTRIES.length - 1]!.id).toBe(OTHER_PHONE_COUNTRY);
  });

  it("у каждой страны есть имя, код и пример; неизвестный код — «другая страна»", () => {
    for (const country of PHONE_COUNTRIES) {
      expect(country.name.length).toBeGreaterThan(0);
      expect(country.example.length).toBeGreaterThan(0);
      if (country.id !== OTHER_PHONE_COUNTRY) expect(country.dial).toMatch(/^\d{1,4}$/u);
    }
    expect(phoneCountry("XX").id).toBe(OTHER_PHONE_COUNTRY);
    expect(phoneCountry("BY").dial).toBe("375");
  });

  it("страны с одним кодом различимы по имени", () => {
    const seven = PHONE_COUNTRIES.filter((c) => c.dial === "7").map((c) => c.name);
    expect(seven).toEqual(["Россия", "Казахстан"]);
  });
});

describe("маска ввода", () => {
  it("российский номер расставляется по шаблону, лишние цифры не входят", () => {
    expect(phoneMasked("RU", "9001234567")).toBe("900 123-45-67");
    expect(phoneMasked("RU", "900123456789")).toBe("900 123-45-67");
    expect(phoneMasked("RU", "9001")).toBe("900 1");
    expect(phoneMasked("RU", "")).toBe("");
  });

  it("из ввода берутся только цифры — буквы и знаки не попадают в номер", () => {
    // Вставленный международный номер не «узнаётся»: код страны выбирается списком,
    // а в поле идёт национальная часть — семёрка становится первой цифрой номера
    expect(phoneMasked("RU", "+7 (900) 123-45-67")).toBe("790 012-34-56");
    expect(phoneMasked("RU", "fsdfsdfdsf")).toBe("");
  });

  it("у каждой страны своя длина и свой шаблон", () => {
    expect(phoneMasked("BY", "291234567")).toBe("29 123-45-67");
    expect(phoneMasked("AM", "77123456")).toBe("77 123-456");
    expect(phoneMasked("TR", "5321234567")).toBe("532 123 45 67");
  });

  it("«другая страна» — свободный ввод, маска не навязывается", () => {
    expect(phoneMasked(OTHER_PHONE_COUNTRY, "971501234567")).toBe("971501234567");
  });
});

describe("когда номер готов", () => {
  it("готов только при полной длине страны", () => {
    expect(phoneComplete("RU", "900123456")).toBe(false);
    expect(phoneComplete("RU", "9001234567")).toBe(true);
    expect(phoneComplete("BY", "291234567")).toBe(true);
    expect(phoneComplete("AM", "7712345")).toBe(false);
  });

  it("«другая страна» — от 8 до 15 цифр вместе с кодом", () => {
    expect(phoneComplete(OTHER_PHONE_COUNTRY, "1234567")).toBe(false);
    expect(phoneComplete(OTHER_PHONE_COUNTRY, "971501234567")).toBe(true);
    expect(phoneComplete(OTHER_PHONE_COUNTRY, "1234567890123456")).toBe(false);
  });

  it("пустое поле готовым не считается", () => {
    expect(phoneComplete("RU", "")).toBe(false);
    expect(phoneComplete(OTHER_PHONE_COUNTRY, "")).toBe(false);
  });
});

describe("что уходит на сервер", () => {
  it("код страны и номер одной строкой в международном виде", () => {
    expect(phoneE164("RU", "9001234567")).toBe("+79001234567");
    expect(phoneE164("BY", "291234567")).toBe("+375291234567");
    expect(phoneE164(OTHER_PHONE_COUNTRY, "971501234567")).toBe("+971501234567");
    expect(phoneE164("RU", "")).toBe("");
  });

  it("собранный номер проходит схему ручки заявки", () => {
    for (const [country, digits] of [
      ["RU", "9001234567"],
      ["KZ", "7011234567"],
      ["BY", "291234567"],
      ["AM", "77123456"],
      ["AE", "501234567"],
      [OTHER_PHONE_COUNTRY, "12025550123"],
    ] as const) {
      const parsed = SelfCheckLeadSchema.safeParse({ name: "Антон", phone: phoneE164(country, digits) });
      expect([country, parsed.success]).toEqual([country, true]);
    }
  });

  it("в заявку уходит международный номер, а не то, что видно в поле", () => {
    const body = leadFormPayload(lead({ channel: "phone", phoneCountry: "BY", phone: "291234567" }));
    expect(body.phone).toBe("+375291234567");
  });
});

describe("отказ виден до отправки", () => {
  it("неполный номер — ошибка у поля, а не после «Отправить»", () => {
    // Девять цифр: схема ручки такой номер пропускает (в нём десять цифр вместе с
    // кодом страны), и поймать недобор может только правило страны
    expect(SelfCheckLeadSchema.safeParse({ name: "Антон", phone: "+7900123456" }).success).toBe(true);
    expect(leadFormErrors(lead({ channel: "phone", phone: "900123456" })).phone).toBeTruthy();
    expect(leadFormErrors(lead({ channel: "phone", phone: "90012345" })).phone).toBeTruthy();
  });

  it("полный номер ошибок не даёт", () => {
    expect(leadFormErrors(lead({ channel: "phone", phone: "9001234567" }))).toEqual({});
  });

  it("другой способ связи телефон не проверяет", () => {
    expect(leadFormErrors(lead({ channel: "telegram", telegram: "@proverkin", phone: "900" }))).toEqual({});
  });
});
