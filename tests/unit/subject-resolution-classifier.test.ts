/**
 * Ported from smoke-orion-analytics-pipeline §3 — LIKELY / morphology / surname+query.
 * NETWORK_CALLS=0 (vitest.config env).
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";
import {
  classifySubjectRelevance,
  generateRussianNameForms,
  matchesToken,
  type SubjectIdentity,
} from "../../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";

const CASE_ID = "case-unit-subject-resolution";

let seq = 0;
function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: CASE_ID,
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-16T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  };
}

const GLINKA_COMPOSER_NOISE = [
  "михаил глинка",
  "композитор",
  "опера",
  "руслан и людмила",
];

const GLINKA_SUBJECT: SubjectIdentity = {
  displayName: "Глинка Сергей Михайлович",
  lastName: "Глинка",
  lastNameVariants: ["glinka"],
  firstNames: ["Сергей", "sergey", "sergei"],
  patronymics: ["Михайлович", "mikhaylovich"],
  aliases: ["Глинка Сергей Михайлович", "sergey glinka"],
  strongIdentifiers: ["773800015809"],
  contextIdentifiers: ["бизнесмен", "предприниматель", "инвестор", "транспорт"],
  wrongFirstNames: [],
  wrongPatronymics: ["николаевич"],
  unrelatedKnownPersons: ["дерипаск"],
  namesakeProfiles: [{ label: "Михаил Глинка (композитор)", noiseTerms: GLINKA_COMPOSER_NOISE }],
  namesakeNoise: GLINKA_COMPOSER_NOISE,
};

describe("subject-resolution-classifier", () => {
  it("surname-only + subject full-name query → LIKELY_SUBJECT", () => {
    const decision = classifySubjectRelevance(
      item({
        title: "Глинка: справочная статья",
        query: "Глинка Сергей Михайлович",
      }),
      GLINKA_SUBJECT
    );
    expect(decision.decision).toBe("LIKELY_SUBJECT");
    expect(decision.reasonCode).toBe("surname_with_subject_query");
  });

  it("surname + context → LIKELY_SUBJECT; namesake conflict → OTHER_SUBJECT", () => {
    const likely = classifySubjectRelevance(
      item({ title: "Глинка инвестирует в транспортный бизнес" }),
      GLINKA_SUBJECT
    );
    expect(likely.decision).toBe("LIKELY_SUBJECT");
    expect(likely.reasonCode).toBe("surname_with_context");

    const other = classifySubjectRelevance(
      item({ title: "Глинка — композитор, опера" }),
      GLINKA_SUBJECT
    );
    expect(other.decision).toBe("OTHER_SUBJECT");
  });

  it("morphology: case forms match; longer derivatives do not", () => {
    const norm = (t: string) => t.toLowerCase().replace(/ё/gu, "е");
    expect(matchesToken(norm("Интервью с Петровым о бизнесе"), "Петров")).toBe(true);
    expect(matchesToken(norm("Заявление Петровой в суд"), "Петров")).toBe(true);
    expect(matchesToken(norm("Петровский район и новости"), "Петров")).toBe(false);
    expect(matchesToken(norm("Дело Глинки в арбитраже"), "Глинка")).toBe(true);

    const petrovForms = generateRussianNameForms("Петров");
    expect(petrovForms).toContain("петровым");
    expect(petrovForms).toContain("петровой");
    expect(petrovForms).not.toContain("петровский");
  });
});
