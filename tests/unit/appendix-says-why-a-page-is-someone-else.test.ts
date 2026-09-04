import { describe, expect, it } from "vitest";
import { subjectMembershipLine } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/appendix";

/**
 * «О другом лице» без причины — утверждение, которое читателю нечем проверить.
 *
 * Заказчик прогона DPA-2026-0049 читал приложение и не понимал, почему часть
 * материалов о его однофамильцах, а часть — о нём. Причина у разметки есть
 * всегда: чужая дата рождения, чужой ИНН, слова тёзки из профиля. Она и
 * печатается — с самим значением, чтобы читатель мог сверить его глазами.
 */

describe("строка принадлежности в приложении", () => {
  it("чужая дата рождения названа значением", () => {
    expect(
      subjectMembershipLine({
        subjectMatch: "OTHER_SUBJECT",
        reason: "foreign_birth_date",
        conflicts: ["10.08.1983"],
      })
    ).toBe("Принадлежность: о другом лице — на странице другая дата рождения (10.08.1983).");
  });

  it("чужой ИНН — тоже", () => {
    expect(
      subjectMembershipLine({
        subjectMatch: "OTHER_SUBJECT",
        reason: "foreign_inn",
        conflicts: ["230811088018"],
      })
    ).toBe("Принадлежность: о другом лице — на странице ИНН другого лица (230811088018).");
  });

  it("слова тёзки из профиля названы списком", () => {
    expect(
      subjectMembershipLine({
        subjectMatch: "OTHER_SUBJECT",
        reason: "namesake_conflict",
        conflicts: ["офтальмолог", "РНИМУ"],
      })
    ).toBe("Принадлежность: о другом лице — признаки однофамильца: офтальмолог, РНИМУ.");
  });

  it("совпало только имя — так и сказано", () => {
    expect(
      subjectMembershipLine({ subjectMatch: "AMBIGUOUS", reason: "full_name_no_anchor", conflicts: [] })
    ).toBe(
      // Слово степени не трогается: «не разобрана» стоит в отчётах и означает
      // ровно то же. Новое здесь — причина после тире.
      "Принадлежность: не разобрана — совпало полное имя, других признаков проверяемого лица на странице нет."
    );
  });

  it("причины нет — прежняя строка без выдумок", () => {
    expect(subjectMembershipLine({ subjectMatch: "OTHER_SUBJECT" })).toBe(
      "Принадлежность: о другом лице."
    );
    expect(subjectMembershipLine({ subjectMatch: "LIKELY_SUBJECT" })).toBe(
      "Принадлежность: вероятно о субъекте."
    );
  });

  it("значения нет — причина названа без пустых скобок", () => {
    expect(
      subjectMembershipLine({ subjectMatch: "OTHER_SUBJECT", reason: "foreign_birth_date", conflicts: [] })
    ).toBe("Принадлежность: о другом лице — на странице другая дата рождения.");
  });

  it("степень неизвестна — строки нет вовсе", () => {
    expect(subjectMembershipLine({ subjectMatch: "SUBJECT_MATCH" })).toBeNull();
  });
});
