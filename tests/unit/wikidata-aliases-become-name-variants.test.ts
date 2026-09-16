/**
 * Псевдонимы из Викиданных становятся вариантами имени.
 *
 * Шаг 0093 читает Викиданные и возвращает псевдонимы («Adolf Hitler»,
 * «Philipp Kirkorov», «Олег Дерипаска»), но вариантами имени они не
 * становились: в контуре ОАЭ страницы на латинице называют субъекта
 * каноническим написанием, а профиль знал только транслитерацию («Gitler»,
 * «Filipp»), и такие страницы уходили в «недостаточно признаков» (шаг 0094).
 *
 * В варианты идут только многословные псевдонимы с общим токеном с именем
 * субъекта; однословные («Фюрер», «Hitler») и инициалы — нет: «фюрер» стоит в
 * текстах о ком угодно.
 */

import { describe, expect, it } from "vitest";
import {
  applyCardAnchorsToProfile,
  nameVariantsFromAliases,
  type WikipediaStructuredFacts,
} from "@/modules/digital-profile/services/persona-card-anchors";
import type { PersonaCard } from "@/modules/digital-profile/services/subject-persona-check";
import type { SubjectProfileStore } from "@/modules/digital-profile/services/subject-profile-admin";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import {
  classifySubjectRelevance,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";

const NAMES = ["Адольф Гитлер", "Гитлер", "Адольф", "Adolf Gitler", "Gitler Adolf"];

describe("отбор псевдонимов в варианты имени", () => {
  it("многословные псевдонимы с общим токеном берутся, запятая нормализуется", () => {
    const out = nameVariantsFromAliases(
      ["Адольф Гитлер", "Гитлер", "Рейхсфюрер", "Гитлер, Адольф", "Фюрер", "Adolf Hitler", "Hitler", "Der Führer"],
      NAMES
    );
    expect(out).toEqual(["Адольф Гитлер", "Гитлер Адольф", "Adolf Hitler"]);
  });

  it("латинское написание фамилии узнаётся по транслитерации, инициалы не берутся", () => {
    const kirkorov = nameVariantsFromAliases(
      ["Филипп Киркоров", "Philipp Kirkorov", "Киркоров Ф. Б.", "Киркоров, Филипп Бедросович", "Киркоров Филипп Бедросович"],
      ["Киркоров Филипп Бедросович", "Киркоров", "Филипп", "Бедросович", "Kirkorov Filipp Bedrosovich"]
    );
    expect(kirkorov).toEqual(["Филипп Киркоров", "Philipp Kirkorov", "Киркоров Филипп Бедросович"]);
  });

  it("псевдоним без общего токена с именем не берётся — это чужое слово, а не имя", () => {
    expect(nameVariantsFromAliases(["Black Star Mafia", "Тимати"], ["Юнусов Тимур Ильдарович", "Юнусов", "Тимур"])).toEqual([]);
  });
});

describe("профиль дела получает варианты имени из карточки", () => {
  const FACTS: WikipediaStructuredFacts = {
    itemId: "Q352",
    birthDate: "1889-04-20",
    facts: [{ property: "P39", kind: "position", label: "рейхсканцлер", strong: true }],
    aliases: ["Адольф Гитлер", "Adolf Hitler", "Гитлер", "Фюрер"],
  };
  const card = {
    source: "wikipedia",
    cardId: "wikipedia:ru:Гитлер, Адольф",
    title: "Гитлер, Адольф",
    lead: null,
    leadRequested: true,
    snippet: "",
    articles: [{ language: "ru", title: "Гитлер, Адольф", url: "https://ru.wikipedia.org/wiki/Гитлер,_Адольф", lead: null, snippet: "" }],
  } as unknown as PersonaCard;
  function memoryStore(): { store: SubjectProfileStore; writes: () => number } {
    let saved: unknown = null;
    let writes = 0;
    const store: SubjectProfileStore = {
      read: () => (saved as never) ?? null,
      write: (_caseId, profile) => { saved = profile; writes += 1; },
    };
    return { store, writes: () => writes };
  }

  it("варианты ложатся рядом с псевдонимами оператора, повтор не дублируется", () => {
    const { store, writes } = memoryStore();
    const args = { caseId: "case-1", subjectName: "Адольф Гитлер", subjectAliases: ["А. Гитлер"], card, structured: FACTS, store };
    const first = applyCardAnchorsToProfile(args);
    expect(first?.profile.aliases).toEqual(["А. Гитлер", "Adolf Hitler"]);
    expect(first?.profile.aliases).not.toContain("Фюрер");
    applyCardAnchorsToProfile(args);
    expect(writes()).toBe(1);
  });
});

describe("классификатор: многословный псевдоним — это полное имя", () => {
  let seq = 0;
  const item = (partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem => ({
    inventoryId: `al-${++seq}`,
    caseId: "case-hitler",
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "google",
    region: "UAE",
    collectedAt: "2026-09-16T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  });
  const base: SubjectIdentity = {
    displayName: "Адольф Гитлер",
    lastName: "Гитлер",
    lastNameVariants: ["gitler"],
    firstNames: ["Адольф", "adolf"],
    patronymics: [],
    aliases: [],
    strongIdentifiers: [],
    contextIdentifiers: [],
    wrongFirstNames: [],
    wrongPatronymics: [],
    unrelatedKnownPersons: [],
    namesakeProfiles: [],
    namesakeNoise: [],
    anchors: {
      birthDate: "1889-04-20",
      phrases: [{ kind: "position", text: "Reichskanzler", strong: true }],
      inn: [],
      domains: [],
    },
  };
  const page = item({
    title: "Adolf Hitler — Wikipedia",
    snippet: "Adolf Hitler was an Austrian-born German politician; as Reichskanzler he led Germany from 1933.",
    sourceUrl: "https://en.wikipedia.org/wiki/Adolf_Hitler",
  });

  it("с псевдонимом в профиле латинская страница с сильным якорем — о субъекте", () => {
    const d = classifySubjectRelevance(page, { ...base, aliases: ["Adolf Hitler"] });
    expect(d.decision).toBe("SUBJECT_MATCH");
  });

  it("без псевдонима та же страница о субъекте не подтверждается", () => {
    const d = classifySubjectRelevance(page, base);
    expect(d.decision).not.toBe("SUBJECT_MATCH");
  });

  it("латинское имя, не совпадающее с транслитерацией, узнаётся по многословному псевдониму целиком", () => {
    const kirkorov: SubjectIdentity = {
      ...base,
      displayName: "Киркоров Филипп Бедросович",
      lastName: "Киркоров",
      lastNameVariants: ["kirkorov"],
      firstNames: ["Филипп", "filipp"],
      patronymics: ["Бедросович", "bedrosovich"],
      anchors: { birthDate: "1967-04-30", phrases: [{ kind: "fact", text: "Alla Pugacheva", strong: true }], inn: [], domains: [] },
    };
    const page = item({
      title: "Philipp Kirkorov: biography",
      snippet: "Philipp Kirkorov married Alla Pugacheva in 1994.",
      sourceUrl: "https://example.org/kirkorov",
    });
    expect(classifySubjectRelevance(page, { ...kirkorov, aliases: ["Philipp Kirkorov"] }).decision).toBe("SUBJECT_MATCH");
    expect(classifySubjectRelevance(page, kirkorov).decision).not.toBe("SUBJECT_MATCH");
  });

  it("однословный псевдоним полным именем не считается", () => {
    const d = classifySubjectRelevance(
      item({ title: "Der Führer und die Partei", snippet: "Reichskanzler seit 1933.", sourceUrl: "https://example.org/fuehrer" }),
      { ...base, aliases: ["Führer"] }
    );
    expect(d.decision).not.toBe("SUBJECT_MATCH");
  });
});
