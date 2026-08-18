/**
 * Строка-запрос с чужим отчеством — о другом человеке.
 *
 * На живом прогоне подсказка «viktor feliksovich vekselberg ofac» получила
 * `INSUFFICIENT_IDENTIFIERS` (совпало одно имя «viktor», фамилии нет) и
 * посчиталась в негативный профиль Рашникова. Вывод о чужом отчестве работал
 * только кириллицей и только рядом с фамилией субъекта — короткую строку
 * запроса он пропускал целиком.
 *
 * Профиль ниже воспроизводит замер живого прогона: отчество в профиле
 * кириллическое, латинская форма приезжает транслитерацией, и раскладка
 * профиля кладёт «filippovich» в имена, а не в отчества.
 */

import { describe, expect, it } from "vitest";
import {
  classifySubjectRelevance,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

let seq = 0;
function line(title: string, surface = "autocomplete"): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `line-${seq}`,
    caseId: "case-unit-foreign-patronymic",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "arsenkin",
    region: "UAE",
    collectedAt: "2026-08-01T00:00:00.000Z",
    evidenceType: "search_result",
    title,
    snippet: "",
    rawMetadata: { surface },
  } as RawInventoryItem;
}

const RASHNIKOV: SubjectIdentity = {
  displayName: "Виктор Филиппович Рашников",
  lastName: "Рашников",
  lastNameVariants: ["rashnikov"],
  // «filippovich» раскладка профиля кладёт в имена — так это выглядит в живом
  // прогоне, и правило обязано работать при таком входе.
  firstNames: ["Виктор", "viktor", "filippovich"],
  patronymics: ["Филиппович"],
  aliases: ["viktor filippovich rashnikov", "Виктор Филиппович Рашников"],
  strongIdentifiers: [],
  contextIdentifiers: ["ммк", "магнитогорск"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

const HOLMSTROM: SubjectIdentity = {
  displayName: "Anders Holmström",
  lastName: "Holmström",
  lastNameVariants: ["holmstrom"],
  firstNames: ["Anders"],
  patronymics: [],
  aliases: ["Anders Holmstrom"],
  strongIdentifiers: [],
  contextIdentifiers: [],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

/**
 * Фамилия по форме неотличима от отчества: «Абрамович», «Рабинович»,
 * «Маркович». У такого субъекта в профиле может не быть отчества вовсе.
 */
const ABRAMOVICH: SubjectIdentity = {
  displayName: "Roman Abramovich",
  lastName: "Абрамович",
  lastNameVariants: ["abramovich"],
  firstNames: ["Роман", "roman"],
  patronymics: [],
  aliases: ["roman abramovich", "Роман Абрамович"],
  strongIdentifiers: [],
  contextIdentifiers: [],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

describe("чужое отчество в строке-запросе", () => {
  it("санкционная подсказка о другом человеке — OTHER_SUBJECT, а не «недостаточно признаков»", () => {
    const d = classifySubjectRelevance(line("viktor feliksovich vekselberg ofac"), RASHNIKOV);
    expect(d.decision).toBe("OTHER_SUBJECT");
    expect(d.reasonCode).toBe("suggestion_foreign_patronymic");
    expect(d.confidence).toBe(0.9);
    expect(d.conflictingIdentifiers.join(" ")).toContain("feliksovich");
  });

  it("кириллическая строка без фамилии субъекта — тоже OTHER_SUBJECT", () => {
    const d = classifySubjectRelevance(line("виктор феликсович вексельберг офшор"), RASHNIKOV);
    expect(d.decision).toBe("OTHER_SUBJECT");
  });

  it("фамилия субъекта с чужим отчеством латиницей — OTHER_SUBJECT", () => {
    const d = classifySubjectRelevance(line("rashnikov viktor feliksovich"), RASHNIKOV);
    expect(d.decision).toBe("OTHER_SUBJECT");
  });

  it("собственное отчество латиницей чужим не объявляется", () => {
    const d = classifySubjectRelevance(line("viktor filippovich"), RASHNIKOV);
    expect(d.decision).toBe("INSUFFICIENT_IDENTIFIERS");
    expect(d.reasonCode).toBe("partial_name_without_surname");
  });

  it("вариант транслитерации собственного отчества — не конфликт", () => {
    const d = classifySubjectRelevance(line("viktor filipovich"), RASHNIKOV);
    expect(d.decision).toBe("INSUFFICIENT_IDENTIFIERS");
  });

  it("своя тройка кириллицей остаётся SUBJECT_MATCH", () => {
    const d = classifySubjectRelevance(line("рашников виктор филиппович жена"), RASHNIKOV);
    expect(d.decision).toBe("SUBJECT_MATCH");
  });

  it("строка без отчества не задета", () => {
    const d = classifySubjectRelevance(line("рашников санкции"), RASHNIKOV);
    expect(d.decision).toBe("AMBIGUOUS");
    expect(d.reasonCode).toBe("surname_only");
  });

  it("на длинной поверхности правило не действует", () => {
    const d = classifySubjectRelevance(line("rashnikov viktor feliksovich", "organic"), RASHNIKOV);
    expect(d.decision).toBe("SUBJECT_MATCH");
  });

  it("без собственного отчества вывод не делается", () => {
    const d = classifySubjectRelevance(line("anders petrovich holmström"), HOLMSTROM);
    expect(d.decision).toBe("SUBJECT_MATCH");
  });

  it("фамилия-«отчество» при пустом отчестве профиля правило не включает", () => {
    // Своего отчества система не знает — «чужесть» была бы догадкой, а она
    // прячет негатив и печатает клиенту непрослеживаемое утверждение.
    const d = classifySubjectRelevance(line("roman petrovich fraud"), ABRAMOVICH);
    expect(d.decision).not.toBe("OTHER_SUBJECT");
    expect(d.decision).toBe("INSUFFICIENT_IDENTIFIERS");
  });

  it("фамилия-«отчество» субъекта чужой не объявляется", () => {
    // Защита живёт в наборе своих форм: «abramovich» приходит из алиасов и
    // транслитераций, поэтому совпадает со своей же фамилией.
    const withPatronymic: SubjectIdentity = { ...ABRAMOVICH, patronymics: ["Аркадьевич"] };
    const d = classifySubjectRelevance(line("roman abramovich sanctions"), withPatronymic);
    expect(d.decision).toBe("SUBJECT_MATCH");
  });

  it("строка без токенов субъекта чужой не объявляется", () => {
    const d = classifySubjectRelevance(line("Iouri chliaifchtein net worth"), RASHNIKOV);
    expect(d.decision).toBe("INSUFFICIENT_IDENTIFIERS");
    expect(d.reasonCode).toBe("no_subject_tokens");
  });
});
