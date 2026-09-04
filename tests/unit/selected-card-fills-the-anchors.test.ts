import { describe, expect, it } from "vitest";
import { applyCardAnchorsToProfile } from "@/modules/digital-profile/services/persona-card-anchors";
import type { PersonaCard } from "@/modules/digital-profile/services/subject-persona-check";
import type { SubjectIdentityProfile } from "@/modules/digital-profile/orion-golden/identity/subject-identity-profile";

/**
 * Признаки выбранной карточки доезжают до профиля, которым размечается прогон.
 *
 * Оператор нажал «Это он» — и слова карточки должны оказаться там же, где
 * лежат его собственные, а не рядом вторым набором. Его фразы при этом не
 * трогаются никогда: карточка дополняет, а не переписывает.
 */

const card = {
  source: "wikipedia",
  cardId: "wiki-1",
  title: "Дерипаска, Олег Владимирович",
  lead: "Олег Дерипаска — основатель компании «Русал».",
  leadRequested: true,
  snippet: "",
  articles: [],
} as unknown as PersonaCard;

const profile = (phrases: Array<{ kind: string; text: string; strong: boolean }>) =>
  ({
    version: "r10-7b-subject-identity-profile-v1",
    caseId: "case-1",
    displayName: "Дерипаска Олег Владимирович",
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
    anchors: { birthDate: "1968-01-02", phrases, inn: [], domains: [] },
  }) as unknown as SubjectIdentityProfile;

function store(initial: SubjectIdentityProfile) {
  const written: SubjectIdentityProfile[] = [];
  return {
    written,
    read: () => (written.length > 0 ? written[written.length - 1]! : initial),
    write: (_caseId: string, p: SubjectIdentityProfile) => {
      written.push(p);
    },
  };
}

describe("признаки карточки в профиле кейса", () => {
  it("фраза карточки становится якорем рядом с датой рождения", () => {
    const s = store(profile([]));
    const out = applyCardAnchorsToProfile({
      caseId: "case-1",
      subjectName: "Дерипаска Олег Владимирович",
      card,
      store: s,
    });
    expect(out?.anchors?.phrases.map((p) => p.text)).toEqual(["Русал"]);
    expect(out?.anchors?.birthDate).toBe("1968-01-02");
  });

  it("фразы оператора не трогаются", () => {
    const mine = [{ kind: "employer", text: "En+ Group", strong: true }];
    const out = applyCardAnchorsToProfile({
      caseId: "case-1",
      subjectName: "Дерипаска Олег Владимирович",
      card,
      store: store(profile(mine)),
    });
    expect(out?.anchors?.phrases.map((p) => p.text)).toEqual(["En+ Group", "Русал"]);
  });

  it("повторное решение по той же карточке ничего не дублирует", () => {
    const s = store(profile([]));
    const args = {
      caseId: "case-1",
      subjectName: "Дерипаска Олег Владимирович",
      card,
      store: s,
    };
    applyCardAnchorsToProfile(args);
    const out = applyCardAnchorsToProfile(args);
    expect(out?.anchors?.phrases.map((p) => p.text)).toEqual(["Русал"]);
    // Второй раз файл не переписывается: писать то же самое незачем.
    expect(s.written).toHaveLength(1);
  });

  it("карточка не дала ни одной фразы — профиль не трогается вовсе", () => {
    const s = store(profile([]));
    const empty = { ...(card as unknown as Record<string, unknown>), lead: "Он предприниматель." };
    expect(
      applyCardAnchorsToProfile({
        caseId: "case-1",
        subjectName: "Дерипаска Олег Владимирович",
        card: empty as unknown as PersonaCard,
        store: s,
      })
    ).toBeNull();
    expect(s.written).toEqual([]);
  });
});
