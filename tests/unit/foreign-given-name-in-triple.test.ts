/**
 * Чужое имя внутри именной тройки — это другой человек.
 *
 * Прогон DPA-2026-0046 привёл в отчёт три записи ИП **посторонних людей с их
 * ИНН**: «IE Borisov Ivan Anatolevich (INN 333409605953)» и две такие же с
 * Олегом и Андреем. Вердикт был `SUBJECT_MATCH / full_name_match` с
 * уверенностью 0,85, потому что совпали фамилия и отчество, а имя не проверял
 * никто: у имени нет опознаваемой формы, в отличие от отчества на «-ович».
 *
 * Признак, у которого есть данные под ним, — **тройка**: чужое имя, стоящее
 * между формой фамилии субъекта и отчеством. Вне тройки правило молчит:
 * «BATE Borisov» и «Anna Borisova» другим лицом не объявляются, потому что
 * ложная чужесть прячет негатив клиента (опись, пункты DM и DN).
 *
 * Область текста — решение шага, а не деталь: на страницах читается **только
 * заголовок**. Сниппет и биография называют родню («брат — Иван Анатольевич
 * Борисов»), и на этой ловушке 14.08.2026 статья о самом субъекте была
 * объявлена чужой, уведя за собой 26 материалов.
 */

import { describe, expect, it } from "vitest";
import { foreignGivenNamesInTriple } from "@/modules/digital-profile/orion-golden/analytics/patronymic-conflict";
import {
  classifySubjectRelevance,
  subjectIdentityFromProfile,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { buildSubjectIdentityProfile } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile-builder";
import { classifierProfileFromIdentityProfile } from "@/modules/digital-profile/services/job-subject-profile";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

/** Личность собирается настоящей цепочкой: раскладку тесты руками не подменяют. */
function identityOfCase(subjectName: string, aliases: string[] = []): SubjectIdentity {
  const profile = buildSubjectIdentityProfile({
    caseId: "case-unit-given-name-triple",
    subjectName,
    aliases,
  });
  return subjectIdentityFromProfile(classifierProfileFromIdentityProfile(profile));
}

const BORISOV = (): SubjectIdentity =>
  identityOfCase("Борисов Анатолий Анатольевич", [
    "Толя Вайлдвей",
    "Толя Wildways",
    "Анатолий Wildways",
  ]);

/** Кадр живого прогона: Google/ОАЭ, organic. Заголовки — из бандла дословно. */
function frame(title: string, overrides: Partial<RawInventoryItem> = {}): RawInventoryItem {
  return {
    inventoryId: "obs-ie-borisov",
    caseId: "case-unit-given-name-triple",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "serper",
    region: "UAE",
    query: "Borisov Anatoliy",
    collectedAt: "2026-09-01T12:25:03.529Z",
    evidenceType: "search_result",
    title,
    snippet: "",
    sourceUrl: "https://www.rusprofile.ru/ip/333409605953",
    rawMetadata: { surface: "organic", engine: "GOOGLE" },
    ...overrides,
  };
}

describe("чужое имя в тройке", () => {
  it("узнаёт постороннего в записи ИП", () => {
    const subject = BORISOV();

    expect(
      foreignGivenNamesInTriple("IE Borisov Ivan Anatolevich (INN 333409605953) - requisites", subject)
    ).toEqual(["ivan"]);
    expect(
      foreignGivenNamesInTriple("IE Borisov Oleg Anatolevich (INN 784000291702) - requisites", subject)
    ).toEqual(["oleg"]);
    expect(
      foreignGivenNamesInTriple("IE Borisov Andrei Anatolevich (INN 590300221516)", subject)
    ).toEqual(["andrei"]);
  });

  it("в строке-подсказке чужое имя при чужом отчестве — тоже тройка", () => {
    expect(foreignGivenNamesInTriple("borisov andrey aleksandrovich", BORISOV())).toEqual([
      "andrey",
    ]);
  });

  it("кириллическая тройка судится тем же правилом", () => {
    expect(foreignGivenNamesInTriple("Борисов Иван Анатольевич — ОГРНИП", BORISOV())).toEqual([
      "иван",
    ]);
  });

  it("своя тройка чужой не объявляется", () => {
    const subject = BORISOV();

    expect(foreignGivenNamesInTriple("Борисов Анатолий Анатольевич", subject)).toEqual([]);
    expect(foreignGivenNamesInTriple("borisov anatoliy anatolevich md", subject)).toEqual([]);
    // Имя субъекта другой школой транслитерации — тот же человек.
    expect(foreignGivenNamesInTriple("Borisov Anatolii Anatolyevich", subject)).toEqual([]);
  });

  it("без отчества признака нет: клуб и однофамилица остаются неразобранными", () => {
    const subject = BORISOV();

    expect(foreignGivenNamesInTriple("A New Giant In Europe: BATE Borisov", subject)).toEqual([]);
    expect(
      foreignGivenNamesInTriple("Anna Borisova charged with fraud - The National", subject)
    ).toEqual([]);
  });

  it("форма фамилии перед отчеством именем не считается", () => {
    // «borisov anatolevich» без имени: первое слово — фамилия, а не чужое имя.
    expect(foreignGivenNamesInTriple("borisov anatolevich profiles", BORISOV())).toEqual([]);
    /*
     * Судебная строка в косвенном падеже: «Борисову Анатольевичу Борисову».
     * Здесь фамилия стоит и в слоте имени, и вплотную к тройке, поэтому
     * проверку близости кадр проходит — и без отдельной защиты падежная форма
     * фамилии субъекта объявилась бы «чужим именем» самого субъекта.
     */
    expect(
      foreignGivenNamesInTriple("Иск к Борисову Анатольевичу Борисову", BORISOV())
    ).toEqual([]);
  });

  it("инициал субъекта чужим именем не считается", () => {
    /*
     * Реестры ИП и судебные карточки пишут «Фамилия И. Отчество». Инициал —
     * это сам субъект, и без порога длины запись о нём уходила из аудита как
     * чужая: слот имени принимал любое слово, включая одну букву.
     */
    const subject = BORISOV();

    expect(foreignGivenNamesInTriple("Борисов А. Анатольевич — ОГРНИП", subject)).toEqual([]);
    expect(foreignGivenNamesInTriple("Borisov A. Anatolevich", subject)).toEqual([]);
    expect(foreignGivenNamesInTriple("ИП Борисов Ан. Анатольевич", subject)).toEqual([]);
    // Полное чужое имя порогом не задевается.
    expect(foreignGivenNamesInTriple("Борисов Иван Анатольевич", subject)).toEqual(["иван"]);
  });

  it("отчество формой фамилии не считается", () => {
    /*
     * «Борисович» начинается с «борисов», и допуск на падежный хвост принимал
     * его за форму фамилии — то есть за якорь тройки. Признак у слова один:
     * отчество по ключу фамилией не бывает, если только это не сама фамилия.
     */
    expect(
      foreignGivenNamesInTriple("Борисович Иван Анатольевич — партнёр", BORISOV())
    ).toEqual([]);
  });

  it("смешанный заголовок оставляет решение прежней лестнице", () => {
    // Материал о двух Борисовых — не «другой человек»: своя тройка в тексте есть.
    expect(
      foreignGivenNamesInTriple(
        "Борисов Анатолий Анатольевич и Борисов Иван Анатольевич — партнёры",
        BORISOV()
      )
    ).toEqual([]);
  });

  it("без структурного отчества субъекта правило молчит", () => {
    // Золотой кейс: у субъекта отчества нет вовсе, тройка не собирается.
    const holmstrom = identityOfCase("Anders Holmström");

    expect(foreignGivenNamesInTriple("Holmström Ivan Anatolevich", holmstrom)).toEqual([]);
  });

  it("фамилия должна стоять вплотную к тройке", () => {
    // Тройка чужая, но фамилии субъекта рядом нет — материал не о нём и не о
    // его однофамильце, и приписывать ему конфликт не из чего.
    expect(foreignGivenNamesInTriple("Иван Петрович Сидоров — директор", BORISOV())).toEqual([]);
  });
});

describe("вердикт классификатора на тройке", () => {
  it("запись ИП постороннего лица — другой человек", () => {
    const verdict = classifySubjectRelevance(
      frame("IE Borisov Ivan Anatolevich (INN 333409605953) - requisites"),
      BORISOV()
    );

    expect({ decision: verdict.decision, reasonCode: verdict.reasonCode }).toEqual({
      decision: "OTHER_SUBJECT",
      reasonCode: "given_name_conflict",
    });
    expect(verdict.conflictingIdentifiers).toContain("ivan");
    expect(verdict.confidence).toBe(0.9);
  });

  it("чужое латинское отчество на странице — тоже другой человек", () => {
    const verdict = classifySubjectRelevance(
      frame("Anatoly Viktorovich Borisov - ORCID", {
        sourceUrl: "https://orcid.org/0000-0002-1825-0097",
      }),
      BORISOV()
    );

    expect(verdict.decision).toBe("OTHER_SUBJECT");
    expect(verdict.reasonCode).toBe("patronymic_conflict");
  });

  it("чужая тройка в сниппете правило не включает", () => {
    /*
     * Область правила имени на страницах — заголовок, и это держится здесь.
     * Сниппет называет родню и партнёров; читая его, правило объявило бы чужой
     * страницу о самом субъекте — цена измерена 14.08.2026 на 26 материалах.
     */
    const verdict = classifySubjectRelevance(
      frame("Борисов Анатолий — фронтмен Wildways", {
        snippet: "Партнёр по бизнесу — Борисов Иван Анатольевич, ИНН 333409605953.",
      }),
      BORISOV()
    );

    expect(verdict.decision).not.toBe("OTHER_SUBJECT");
    expect(verdict.conflictingIdentifiers).toEqual([]);
  });

  it("подсказка судится целой строкой, а не заголовком страницы", () => {
    const verdict = classifySubjectRelevance(
      frame("borisov andrey aleksandrovich", {
        rawMetadata: { surface: "autocomplete", engine: "GOOGLE" },
        sourceUrl: "",
      }),
      BORISOV()
    );

    expect(verdict.decision).toBe("OTHER_SUBJECT");
    expect(verdict.reasonCode).toBe("given_name_conflict");
  });

  it("ИНН субъекта не даёт объявить материал чужим", () => {
    // Тот же размен, что у чужого отчества: сильный идентификатор снимает
    // вывод «другой человек», но не делает материал подтверждённым — остаётся
    // «смешанные признаки», и решает аналитик.
    const subject = BORISOV();
    const withInn: SubjectIdentity = { ...subject, strongIdentifiers: ["325705267500"] };
    const verdict = classifySubjectRelevance(
      frame("IE Borisov Ivan Anatolevich (INN 325705267500) - requisites"),
      withInn
    );

    expect(verdict.decision).not.toBe("OTHER_SUBJECT");
    expect(verdict.reasonCode).toBe("mixed_identity_signals");
  });

  it("своя тройка вердикта не теряет", () => {
    const verdict = classifySubjectRelevance(
      frame("Борисов Анатолий Анатольевич — Wildways"),
      BORISOV()
    );

    expect(verdict.decision).toBe("SUBJECT_MATCH");
  });
});
