/**
 * ИНН, добытый из корпуса, — предложение оператору, а не идентификатор.
 *
 * Прогон 0049: `discoverInnsLinkedToSubject` собрал три ИНН по соседству с
 * точным ФИО и положил их в `knownIdentifiers.inn`; классификатор читает это
 * поле как `strongIdentifiers` и выдаёт `strong_identifier_match` 0.98 — то
 * есть корпус, собранный по одному совпадению имени, сам себя и подтверждал.
 * Двое из трёх ИНН принадлежали рязанскому и московскому однофамильцам.
 *
 * Теперь добытое живёт отдельным блоком `discovered` (с адресами, по которым
 * его видно), а идентификатором становится только `anchors.inn` оператора.
 * Файлы прежних кейсов читаются так же: их `knownIdentifiers.inn` — предложение.
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import { buildSubjectIdentityProfile } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile-builder";
import { classifierProfileFromIdentityProfile } from "@/modules/digital-profile/services/job-subject-profile";
import { mergeDiscoveredIntoProfile } from "@/modules/digital-profile/services/job-subject-profile-bootstrap";
import type { SubjectIdentityProfile } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile";

let seq = 0;
function item(title: string, snippet: string, url: string): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `inn-${seq}`,
    caseId: "case-egorov",
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-09-03T00:00:00.000Z",
    evidenceType: "search_result",
    title,
    snippet,
    sourceUrl: url,
  } as RawInventoryItem;
}

const ITEMS = [
  item(
    "Егоров Алексей Евгеньевич ИНН 772809603828",
    "Краткая справка: являлся руководителем 1 организации",
    "https://www.rusprofile.ru/person/egorov-ae-772809603828"
  ),
  item(
    "ИП Егоров Алексей Евгеньевич, Опочка",
    "ИНН 772809603828, выписка из ЕГРИП",
    "https://www.rusprofile.ru/ip/306603112500025"
  ),
];

describe("добытый ИНН", () => {
  it("едет предложением с адресами, а не идентификатором", () => {
    const profile = buildSubjectIdentityProfile({
      caseId: "case-egorov",
      subjectName: "Егоров Алексей Евгеньевич",
      inventory: { items: ITEMS },
    });
    expect(profile.knownIdentifiers.inn).toBeUndefined();
    const discovered = profile.discovered?.inn ?? [];
    // тип известен — приведение не нужно
    expect(discovered.map((d: { inn: string }) => d.inn)).toEqual(["772809603828"]);
    expect(discovered[0]?.urls).toContain("https://www.rusprofile.ru/ip/306603112500025");
    // Запросы сбора по чужому ИНН не строятся.
    expect(profile.queryVariants.some((q) => q.includes("772809603828"))).toBe(false);
  });

  it("классификатор берёт ИНН только у оператора", () => {
    const legacy = {
      version: "r10-7b-subject-identity-profile-v1",
      caseId: "case-egorov",
      displayName: "Егоров Алексей Евгеньевич",
      aliases: [],
      transliterations: [],
      queryVariants: [],
      knownIdentifiers: { inn: ["620500012596", "772809603828"] },
      negativeIdentitySignals: {
        wrongPatronymics: [],
        wrongNames: [],
        wrongBirthDates: [],
        unrelatedKnownPersons: [],
      },
      regionHints: [],
      languageHints: ["ru"],
    } as unknown as SubjectIdentityProfile;

    expect(classifierProfileFromIdentityProfile(legacy).knownIdentifiers?.inn).toEqual([]);

    const anchored = {
      ...legacy,
      anchors: { birthDate: "1977-11-30", phrases: [], inn: ["231112942662"], domains: [] },
    } as unknown as SubjectIdentityProfile;
    const adapted = classifierProfileFromIdentityProfile(anchored);
    expect(adapted.knownIdentifiers?.inn).toEqual(["231112942662"]);
    expect(adapted.anchors?.birthDate).toBe("1977-11-30");
  });
});

describe("слияние добытого в существующий профиль", () => {
  const operatorProfile = {
    version: "r10-7b-subject-identity-profile-v1",
    caseId: "case-egorov",
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
    anchors: {
      birthDate: null,
      phrases: [{ kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true }],
      inn: [],
      domains: [],
    },
  } as unknown as SubjectIdentityProfile;

  it("дата рождения кейса доезжает, якоря оператора не трогаются", () => {
    const built = buildSubjectIdentityProfile({
      caseId: "case-egorov",
      subjectName: "Егоров Алексей Евгеньевич",
      inventory: { items: ITEMS },
    });
    const merged = mergeDiscoveredIntoProfile(operatorProfile, built, "1977-11-30");
    expect(merged.anchors?.birthDate).toBe("1977-11-30");
    expect(merged.anchors?.phrases).toEqual(operatorProfile.anchors?.phrases);
    expect(merged.discovered?.inn?.map((d: { inn: string }) => d.inn)).toEqual(["772809603828"]);
    expect(merged.knownIdentifiers.inn).toBeUndefined();
  });

  it("правка профиля не нужна, если ничего не изменилось", () => {
    const built = buildSubjectIdentityProfile({
      caseId: "case-egorov",
      subjectName: "Егоров Алексей Евгеньевич",
      inventory: { items: [] },
    });
    const once = mergeDiscoveredIntoProfile(operatorProfile, built, null);
    const twice = mergeDiscoveredIntoProfile(once, built, null);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});
