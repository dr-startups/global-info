import { describe, expect, it } from "vitest";
import { subjectInputHash } from "@/modules/digital-profile/services/subject-persona-check";

/**
 * Признак «решение относится к этим данным» задаётся содержимым данных
 * субъекта, а не фактом нажатия. Косметика записи не должна снимать уже
 * принятое решение, а смена сути — обязана.
 */
describe("хеш входа субъекта", () => {
  const base = {
    fullName: "Петров Иван Иванович",
    aliases: ["Иван Петров", "Пётр"],
    dateOfBirth: "1970-03-05",
  };

  it("регистр, лишние пробелы, порядок алиасов и ё/е его не двигают", () => {
    expect(
      subjectInputHash({
        fullName: "  петров   иван ИВАНОВИЧ ",
        aliases: ["Петр", "иван  петров"],
        dateOfBirth: "1970-03-05",
      })
    ).toBe(subjectInputHash(base));
  });

  it("другая фамилия — другой хеш", () => {
    expect(subjectInputHash({ ...base, fullName: "Сидоров Иван Иванович" })).not.toBe(
      subjectInputHash(base)
    );
  });

  it("другая дата рождения — другой хеш", () => {
    expect(subjectInputHash({ ...base, dateOfBirth: "1970-03-06" })).not.toBe(
      subjectInputHash(base)
    );
  });

  it("дата рождения не заполнена и заполнена — разные хеши", () => {
    expect(subjectInputHash({ ...base, dateOfBirth: null })).not.toBe(subjectInputHash(base));
  });

  it("другой состав алиасов — другой хеш", () => {
    expect(subjectInputHash({ ...base, aliases: [...base.aliases, "И. И. Петров"] })).not.toBe(
      subjectInputHash(base)
    );
  });
});
