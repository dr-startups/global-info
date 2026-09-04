import { describe, expect, it } from "vitest";
import { buildSubjectIdentityProfile } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile-builder";
import { classifierProfileFromIdentityProfile } from "@/modules/digital-profile/services/job-subject-profile";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

/**
 * Город, добытый из корпуса, признаком субъекта не становится.
 *
 * `discoverLocations` собирал названия городов по словарю («тверск|москв|
 * краснодар|осташков|дубай»), клал их в `knownIdentifiers.locations`, а оттуда
 * они уезжали в контекст классификации — то есть корпус подтверждался тем, что
 * система сама из него достала. Ровно этой формы были все три причины мешанины
 * прогона DPA-2026-0049. Регион якорем не является и по решению владельца
 * (0054, №7): гребец «Динамо», депутат и «Опора» — все краснодарские.
 */

const item = (title: string, snippet: string): RawInventoryItem =>
  ({
    inventoryId: `i-${title.length}-${snippet.length}`,
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "serper",
    region: "RU",
    collectedAt: "2026-01-01T00:00:00.000Z",
    evidenceType: "search_result",
    title,
    snippet,
    sourceUrl: "https://example.org/a",
    rawMetadata: {},
  }) as unknown as RawInventoryItem;

describe("города из корпуса", () => {
  const profile = buildSubjectIdentityProfile({
    caseId: "case-1",
    subjectName: "Егоров Алексей Евгеньевич",
    inventory: {
      items: [
        item("Егоров Алексей Евгеньевич — судья", "Арбитражный суд Краснодарского края, Краснодар"),
        item("Егоров Алексей Евгеньевич", "офтальмолог, Москва, клиника"),
      ],
    },
  });

  it("в профиль не попадают", () => {
    // Поля нет вовсе: у профиля больше нет места, куда добытый город мог бы
    // лечь признаком.
    expect(JSON.stringify(profile.knownIdentifiers)).not.toMatch(/краснодар|москв/iu);
  });

  it("и в контекст классификации тоже", () => {
    expect(classifierProfileFromIdentityProfile(profile).contextIdentifiers).toEqual([]);
  });
});
