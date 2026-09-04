/**
 * Контекст-слова прежних кейсов не пропадают при переходе на якоря.
 *
 * Дату рождения кейса в профиль приносит бутстрап, и её одной достаточно, чтобы
 * включить строгую лестницу. Оператор, который до этого ввёл признаки в поле
 * контекст-слов, не должен обнаружить, что его ввод перестал читаться: слово из
 * старого поля — тот же признак, названный раньше.
 */

import { describe, expect, it } from "vitest";
import { classifierProfileFromIdentityProfile } from "@/modules/digital-profile/services/job-subject-profile";
import type { SubjectIdentityProfile } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile";

const base = {
  version: "r10-7b-subject-identity-profile-v1",
  caseId: "case-1",
  displayName: "Егоров Алексей Евгеньевич",
  aliases: [],
  transliterations: [],
  queryVariants: [],
  knownIdentifiers: {},
  negativeIdentitySignals: {
    wrongPatronymics: [],
    wrongNames: [],
    wrongBirthDates: [],
    unrelatedKnownPersons: [],
  },
  regionHints: [],
  languageHints: ["ru"],
} as unknown as SubjectIdentityProfile;

describe("перенос контекст-слов в якоря", () => {
  it("при якорях без фраз старые слова становятся фразами", () => {
    const p = classifierProfileFromIdentityProfile({
      ...base,
      contextIdentifiers: ["Арбитражный суд Краснодарского края", "судья"],
      anchors: { birthDate: "1977-11-30", phrases: [], inn: [], domains: [] },
    } as unknown as SubjectIdentityProfile);
    expect(p.anchors?.phrases).toEqual([
      { kind: "fact", text: "Арбитражный суд Краснодарского края", strong: true },
      { kind: "fact", text: "судья", strong: false },
    ]);
    // Один владелец вопроса: старое поле классификатору больше не отдаётся.
    expect(p.contextIdentifiers).toEqual([]);
  });

  it("свои фразы оператора старые слова не вытесняют", () => {
    const p = classifierProfileFromIdentityProfile({
      ...base,
      contextIdentifiers: ["судья"],
      anchors: {
        birthDate: null,
        phrases: [{ kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true }],
        inn: [],
        domains: [],
      },
    } as unknown as SubjectIdentityProfile);
    expect(p.anchors?.phrases).toHaveLength(1);
    expect(p.anchors?.phrases[0]?.kind).toBe("employer");
  });

  it("без якорей профиль читается как прежде", () => {
    const p = classifierProfileFromIdentityProfile({
      ...base,
      contextIdentifiers: ["судья"],
    } as unknown as SubjectIdentityProfile);
    expect(p.anchors).toBeUndefined();
    expect(p.contextIdentifiers).toEqual(["судья"]);
  });
});
