import { describe, expect, it } from "vitest";
import { CreateDigitalProfileCaseSchema } from "@/modules/digital-profile/validation/case-schemas";

/**
 * Дело без даты рождения не заводится.
 *
 * Дата рождения уже работает как признак субъекта: уходит в запрос
 * санкционного скрининга и отличает санкционную карточку проверяемого лица от
 * карточки полного тёзки на панели персоны. Дело, заведённое без неё, теряет
 * этот признак молча. Сайт самопроверки спрашивает дату обязательно, и
 * админка отвечает на тот же вопрос так же — у одного правила один ответ.
 *
 * Отказ говорит, зачем дата нужна, а не «поле обязательно».
 */

const valid = {
  fullName: "Иванов Иван Иванович",
  lawfulBasis: "LEGITIMATE_INTEREST",
  consentStatus: "NOT_REQUIRED",
};

const issuesText = (input: Record<string, unknown>) =>
  JSON.stringify(CreateDigitalProfileCaseSchema.safeParse(input).error?.issues ?? []);

describe("дата рождения в карточке дела", () => {
  it("дата есть — дело заводится", () => {
    const parsed = CreateDigitalProfileCaseSchema.safeParse({ ...valid, birthDate: "1985-03-12" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.birthDate.toISOString().slice(0, 10)).toBe("1985-03-12");
  });

  it("даты нет — отказ у поля даты и объясняет, зачем она", () => {
    const parsed = CreateDigitalProfileCaseSchema.safeParse(valid);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.join("."))).toContain("birthDate");
    expect(issuesText(valid)).toMatch(/дат[уы] рождения/u);
    expect(issuesText(valid)).toMatch(/тёзк/u);
  });

  it.each([
    ["пустая строка", ""],
    ["null", null],
  ])("%s — тот же отказ, а не ошибка типа", (_label, birthDate) => {
    const input = { ...valid, birthDate };
    expect(CreateDigitalProfileCaseSchema.safeParse(input).success).toBe(false);
    expect(issuesText(input)).toMatch(/дат[уы] рождения/u);
  });

  it("непонятная дата остаётся непонятной датой", () => {
    const input = { ...valid, birthDate: "тридцатое" };
    expect(CreateDigitalProfileCaseSchema.safeParse(input).success).toBe(false);
    expect(issuesText(input)).toContain("Invalid date");
  });
});
