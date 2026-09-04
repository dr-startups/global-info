/**
 * Машинная часть профиля обновляется и тогда, когда файл кейса уже есть.
 *
 * Бутстрап звался только при отсутствии файла: у прогона DPA-2026-0049 профиль
 * уже лежал — с тремя чужими ИНН и без даты рождения, — и ни один следующий
 * прогон его не поправил бы. Дата рождения приходит из карточки кейса,
 * предложения и чужие отчества — из свежего корпуса; якоря и тёзки оператора не
 * трогаются никогда.
 */

import { describe, expect, it } from "vitest";
import {
  bootstrapSubjectProfileFromCollection,
  mergeDiscoveredIntoProfile,
} from "@/modules/digital-profile/services/job-subject-profile-bootstrap";
import type { SubjectIdentityProfile } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile";

const operator = {
  version: "r10-7b-subject-identity-profile-v1",
  caseId: "case-1",
  displayName: "Егоров Алексей Евгеньевич",
  aliases: [],
  transliterations: [],
  queryVariants: [],
  knownIdentifiers: { inn: ["620500012596"] },
  negativeIdentitySignals: {
    wrongPatronymics: ["владимирович"],
    wrongNames: [],
    wrongBirthDates: [],
    unrelatedKnownPersons: [],
  },
  regionHints: [],
  languageHints: ["ru"],
  anchors: {
    birthDate: null,
    phrases: [{ kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true }],
    inn: ["231112942662"],
    domains: [],
  },
} as unknown as SubjectIdentityProfile;

const built = {
  ...operator,
  anchors: { birthDate: null, phrases: [], inn: [], domains: [] },
  knownIdentifiers: {},
  discovered: { inn: [{ inn: "772809603828", regionCode: "77", urls: ["https://rusprofile.ru/x"] }] },
  negativeIdentitySignals: {
    wrongPatronymics: ["сергеевич"],
    wrongNames: [],
    wrongBirthDates: [],
    unrelatedKnownPersons: [],
  },
} as unknown as SubjectIdentityProfile;

describe("слияние в существующий профиль", () => {
  const merged = mergeDiscoveredIntoProfile(operator, built, "1977-11-30");

  it("дата рождения кейса доезжает", () => {
    expect(merged.anchors?.birthDate).toBe("1977-11-30");
  });

  it("якоря оператора не тронуты", () => {
    expect(merged.anchors?.phrases).toEqual(operator.anchors?.phrases);
    expect(merged.anchors?.inn).toEqual(["231112942662"]);
  });

  it("предложения обновляются свежими", () => {
    expect(merged.discovered?.inn?.map((d: { inn: string }) => d.inn)).toEqual(["772809603828"]);
  });

  it("чужие отчества копятся, а не затираются", () => {
    expect(merged.negativeIdentitySignals.wrongPatronymics).toEqual(["владимирович", "сергеевич"]);
  });

  it("прежнее поле ИНН остаётся в файле, но идентификатором не становится", () => {
    expect(merged.knownIdentifiers.inn).toEqual(["620500012596"]);
  });
});

describe("бутстрап поверх заведённого профиля", () => {
  it("читает файл кейса, дополняет его и возвращает профиль с якорями оператора", async () => {
    const stored: SubjectIdentityProfile[] = [];
    const out = await bootstrapSubjectProfileFromCollection({
      caseId: "case-1",
      baseReportRunId: "run-base",
      enrichmentRunId: null,
      observations: [],
      subject: {
        fullName: "Егоров Алексей Евгеньевич",
        aliases: [],
        dateOfBirth: "1977-11-30",
      },
      store: {
        read: () => operator,
        write: (_caseId, profile) => {
          stored.push(profile);
        },
      },
    });
    // Признак оператора доехал до классификатора, а дата рождения — до профиля.
    expect(out?.profile.anchors?.phrases[0]?.text).toBe("Арбитражный суд Краснодарского края");
    expect(out?.profile.anchors?.birthDate).toBe("1977-11-30");
    // Идентификатором остаётся только ИНН оператора.
    expect(out?.profile.knownIdentifiers?.inn).toEqual(["231112942662"]);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.anchors?.phrases).toEqual(operator.anchors?.phrases);
  });

  it("повторный прогон на тех же данных файл не переписывает", async () => {
    let current = mergeDiscoveredIntoProfile(operator, operator, "1977-11-30");
    let writes = 0;
    const run = () =>
      bootstrapSubjectProfileFromCollection({
        caseId: "case-1",
        baseReportRunId: "run-base",
        enrichmentRunId: null,
        observations: [],
        subject: { fullName: "Егоров Алексей Евгеньевич", aliases: [], dateOfBirth: "1977-11-30" },
        store: {
          read: () => current,
          write: (_caseId, profile) => {
            writes += 1;
            current = profile;
          },
        },
      });
    await run();
    const afterFirst = writes;
    await run();
    expect(writes).toBe(afterFirst);
  });
});
