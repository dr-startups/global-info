/**
 * Санкционные реестры читаются как реестры (шаг 0149).
 *
 * Прогон Мельниченко (DPA-2026-0075, 22.09.2026), стр. 56–58 и 10:
 *
 * - запись OFAC SDN («Date of Birth: 08 Mar 1972») осталась «принадлежность не
 *   подтверждена», хотя дата — ровно признак субъекта: признак не знал
 *   английских написаний даты;
 * - французский реестр заморозки активов печатался «Нейтральным» при
 *   подтверждённой принадлежности: домена нет в списке негативных площадок, а
 *   французского текста словарь не читает;
 * - блок «Международные базы» подписал запись OFAC заголовком новости с
 *   другого домена.
 */

import { describe, expect, it } from "vitest";
import {
  birthDateMatch,
  foreignBirthDates,
} from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";
import { resolveRowAdverse } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import { buildInternationalDatabases } from "@/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import {
  classifySubjectRelevance,
  subjectIdentityFromProfile,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { CanonicalClaim } from "@/modules/digital-profile/orion-golden/contracts/canonical-claim";

const DOB = "1972-03-08";

describe("дата рождения в английских написаниях", () => {
  for (const text of [
    "Date of Birth: 08 Mar 1972, Remarks: Place of Birth Gomel",
    "Andrey Melnichenko (born 8 Mar 1972) is a Russian industrialist",
    "born March 8, 1972 in Gomel",
    "born Mar. 8, 1972",
    "Date of birth: 08 March 1972",
    "родился 08 марта 1972 года",
  ]) {
    it(`Д: своя дата узнаётся — «${text.slice(0, 40)}…»`, () => {
      expect(birthDateMatch(text, DOB)).not.toBeNull();
    });
  }

  it("Д-граница: «18 марта 1972» — не своя дата «8 марта 1972»", () => {
    // Совпадение искалось подстрокой: «8 марта 1972» находилось внутри
    // «18 марта 1972», и тёзка, родившийся 18-го, получал признак субъекта.
    expect(birthDateMatch("родился 18 марта 1972 года", DOB)).toBeNull();
    expect(birthDateMatch("born 28 March 1972", DOB)).toBeNull();
    expect(birthDateMatch("Date of Birth: 18.03.1972", DOB)).toBeNull();
  });

  it("Д-чужая: чужая дата в тех же написаниях — чужая", () => {
    expect(foreignBirthDates("Date of Birth: 16 Jun 1991", DOB)).toEqual(["16 Jun 1991"]);
    expect(foreignBirthDates("born June 16, 1991", DOB)).toEqual(["June 16, 1991"]);
  });

  it("Д-живой: запись OFAC SDN со сниппетом прогона — «это он»", () => {
    // Профиль того же вида, что у прогона: имя, дата рождения и признаки
    // сверх имени. Материалов дела в тесте нет — только публичные сведения.
    const profile = {
      displayName: "Мельниченко Андрей Игоревич",
      fullNameRu: { lastName: "Мельниченко", firstName: "Андрей", patronymic: "Игоревич" },
      givenNames: ["Андрей"],
      familyNames: ["Мельниченко"],
      patronymics: ["Игоревич"],
      aliases: ["Andrey Melnichenko", "Andrey Igorevich Melnichenko"],
      transliterations: ["melnichenko andrey igorevich", "andrey melnichenko"],
      namesakeProfiles: [],
      contextIdentifiers: [],
      anchors: {
        birthDate: DOB,
        phrases: [{ kind: "employer", text: "EuroChem", strong: true }],
        inn: [],
        domains: ["eurochemgroup.com"],
      },
      knownIdentifiers: { inn: [] },
      negativeIdentitySignals: { wrongPatronymics: [], wrongNames: [], unrelatedKnownPersons: [] },
    };
    const d = classifySubjectRelevance(
      {
        inventoryId: "sdn",
        caseId: "case-0149",
        reportRunId: "run-0149",
        source: "serp_observation",
        provider: "serper",
        region: "UAE",
        collectedAt: "2026-09-22",
        evidenceType: "search_result",
        title: "Sanctions List Search",
        snippet:
          "MELNICHENKO, Program: RUSSIA-EO14024. First Name: Andrey Igorevich, Nationality: Russia. " +
          "Title: Citizenship: Date of Birth: 08 Mar 1972, Remarks: Place of Birth ...",
        sourceUrl: "https://sanctionssearch.ofac.treas.gov/Details.aspx?id=38238",
      } as never,
      subjectIdentityFromProfile(profile as never)
    );
    expect(d.decision).toBe("SUBJECT_MATCH");
  });
});

describe("официальный санкционный реестр негативен сам по себе", () => {
  for (const url of [
    "https://gels-avoirs.dgtresor.gouv.fr/Gels/RegistreDetail?idRegistre=4408",
    "https://search-uk-sanctions-list.service.gov.uk/designations/RUS0774/Individual",
    "https://www.sanctionsmap.eu/#/main/details/26/?search=%7B%7D",
    "https://scsanctions.un.org/fop/fop?xml=htdocs/resources/xml/en/consolidated.xml",
  ]) {
    it(`Р: ${new URL(url).hostname}`, () => {
      expect(resolveRowAdverse({ url, title: "Détail du registre - Gels des Avoirs" })).toBe(true);
    });
  }
});

const claim = (over: Partial<CanonicalClaim>): CanonicalClaim =>
  ({
    claimId: "claim-00000000",
    // Живая форма: сводная официальная запись с заголовком СМИ.
    claimKind: "OFFICIAL_RECORD",
    subjectMatch: "SUBJECT_MATCH",
    themeIds: ["sanctions_pep_rca_compliance"],
    materialityLevel: "HIGH",
    evidenceRefs: ["inventory:obs-1"],
    sourceDomains: ["lenta.ru", "sanctionssearch.ofac.treas.gov"],
    originalTitle: "Переговоры с Украиной, санкции ЕС, глобальное потепление...",
    originalDomain: "lenta.ru",
    clientQualification: "",
    ...over,
  }) as unknown as CanonicalClaim;

describe("запись базы подписана своим заголовком", () => {
  it("З1: сводная официальная запись с заголовком СМИ запись базы не подписывает", () => {
    // Форма живого утверждения прогона Мельниченко: OFFICIAL_RECORD, темы
    // санкций и связей, домены СМИ и реестров вперемешку, заголовок — rtvi.com.
    const [entry] = buildInternationalDatabases(
      [
        claim({
          claimKind: "OFFICIAL_RECORD",
          sourceDomains: ["independent.co.uk", "ft.com", "sanctionssearch.ofac.treas.gov", "gazeta.ru"],
          originalDomain: "rtvi.com",
        } as Partial<CanonicalClaim>),
      ],
      ["Мельниченко Андрей Игоревич"]
    );
    expect(entry!.statusSummary).not.toContain("Переговоры с Украиной");
  });

  it("З3: запись комплаенс-базы подписана своим именем, где бы ни лежал профиль", () => {
    // Карточка базы без адреса страницы: заголовок — имя в самой записи. Так
    // устроены импортированные записи Dow Jones и LexisNexis золотого кейса.
    const [entry] = buildInternationalDatabases(
      [
        claim({
          claimKind: "DATABASE_STATUS",
          sourceDomains: ["lexisnexis.com"],
          originalTitle: "Johan Holmstrom",
          originalDomain: "example.com",
        }),
      ],
      ["Johan Holmstrom"]
    );
    expect(entry!.statusSummary).toContain("«Johan Holmstrom»");
  });

  it("З2: заголовок с домена базы — подписывает", () => {
    const [entry] = buildInternationalDatabases(
      [
        claim({}),
        claim({
          claimId: "claim-11111111",
          materialityLevel: "MEDIUM",
          originalTitle: "MELNICHENKO, Andrey Igorevich — SDN",
          originalDomain: "sanctionssearch.ofac.treas.gov",
        }),
      ],
      ["Мельниченко Андрей Игоревич"]
    );
    expect(entry!.statusSummary).toContain("MELNICHENKO, Andrey Igorevich — SDN");
  });
});
