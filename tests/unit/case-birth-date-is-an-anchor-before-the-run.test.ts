import { describe, expect, it } from "vitest";
import {
  getSubjectProfileForEdit,
  saveSubjectProfileEdits,
} from "@/modules/digital-profile/services/subject-profile-admin";
import type { SubjectIdentityProfile } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile";

/**
 * Дата рождения — признак кейса, а не поле формы.
 *
 * Признаки вводятся **до** сбора, а `anchors.birthDate` до шага 0054 появлялся
 * только на бутстрапе, то есть после первого прогона: панель показывала бы
 * оператору «дата рождения не указана» на кейсе, где она указана, и кнопка
 * подтверждения по признакам не появлялась бы вовсе. Владелец правит дату в
 * карточке дела — оттуда она и берётся, что бы ни прислал кабинет.
 */

function memoryStore(initial: SubjectIdentityProfile | null) {
  const written: SubjectIdentityProfile[] = [];
  return {
    written,
    read: () => (written.length > 0 ? written[written.length - 1]! : initial),
    write: (_caseId: string, profile: SubjectIdentityProfile) => {
      written.push(profile);
    },
  };
}

describe("дата рождения кейса стоит в признаках до первого прогона", () => {
  it("черновик профиля несёт дату кейса, хотя файла ещё нет", () => {
    const store = memoryStore(null);
    const { profile, exists } = getSubjectProfileForEdit({
      caseId: "case-anchor-dob",
      subjectName: "Егоров Алексей Евгеньевич",
      subjectDateOfBirth: "1977-11-30",
      store,
    });
    expect(exists).toBe(false);
    expect(profile.anchors?.birthDate).toBe("1977-11-30");
  });

  it("даты у дела нет — признак не выдумывается", () => {
    const { profile } = getSubjectProfileForEdit({
      caseId: "case-anchor-dob",
      subjectName: "Егоров Алексей Евгеньевич",
      subjectDateOfBirth: null,
      store: memoryStore(null),
    });
    expect(profile.anchors?.birthDate ?? null).toBeNull();
  });

  it("дата из тела запроса в профиль не попадает — только дата дела", () => {
    const store = memoryStore(null);
    const { profile } = saveSubjectProfileEdits({
      caseId: "case-anchor-dob",
      subjectName: "Егоров Алексей Евгеньевич",
      subjectDateOfBirth: "1977-11-30",
      edits: {
        anchors: {
          birthDate: "1984-06-15",
          phrases: [{ kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true }],
          inn: [],
          domains: [],
        },
      },
      store,
    });
    expect(profile.anchors?.birthDate).toBe("1977-11-30");
    expect(store.written).toHaveLength(1);
    expect(store.written[0]?.anchors?.phrases[0]?.text).toBe(
      "Арбитражный суд Краснодарского края"
    );
  });
});
