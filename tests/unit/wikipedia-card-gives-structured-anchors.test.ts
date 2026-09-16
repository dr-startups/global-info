/**
 * Карточка Википедии даёт признаки из структуры, а не из прозы.
 *
 * Прогон «Адольф Гитлер» 15.09.2026: тестировщик выбрал карточку Википедии,
 * как задумано шагом 0054, а карточка дала четыре слабых слова из лида
 * («Германского», «Германии»…) и пустую дату рождения. 185 из 2062 материалов
 * отнесены к субъекту, две темы риска. Структура статьи — Викиданные — не
 * читалась вовсе, хотя именно там то, чем человек отличается от тёзки:
 * дата рождения, должности, работодатель, партия, семья (шаг 0093).
 */

import { describe, expect, it } from "vitest";
import {
  anchorsFromStructuredFacts,
  type WikipediaStructuredFacts,
} from "@/modules/digital-profile/services/persona-card-anchors";
import { applyCardAnchorsToProfile } from "@/modules/digital-profile/services/persona-card-anchors";
import { WikipediaProvider } from "@/modules/digital-profile/providers/wikipedia-provider";
import type { PersonaCard } from "@/modules/digital-profile/services/subject-persona-check";
import type { SubjectProfileStore } from "@/modules/digital-profile/services/subject-profile-admin";

const NAMES = ["Адольф Гитлер", "Гитлер", "Адольф", "Adolf Hitler"];

const FACTS: WikipediaStructuredFacts = {
  itemId: "Q352",
  birthDate: "1889-04-20",
  facts: [
    { property: "P39", kind: "position", label: "рейхсканцлер Германии", strong: true },
    { property: "P39", kind: "position", label: "фюрер", strong: true },
    { property: "P102", kind: "fact", label: "НСДАП", strong: true },
    { property: "P26", kind: "fact", label: "Ева Браун", strong: true },
    { property: "P22", kind: "fact", label: "Алоис Гитлер", strong: true },
    { property: "P69", kind: "education", label: "Реальное училище в Линце", strong: false },
    { property: "P19", kind: "birthPlace", label: "Браунау-ам-Инн", strong: false },
  ],
  aliases: ["Adolf Hitler", "Гитлер"],
};

describe("признаки из структуры карточки", () => {
  const anchors = anchorsFromStructuredFacts(FACTS, NAMES);
  const byText = new Map(anchors.phrases.map((p) => [p.text, p]));

  it("дата рождения берётся из P569 с точностью до дня", () => {
    expect(anchors.birthDate).toBe("1889-04-20");
  });

  it("должность, партия и супруг — сильные признаки своего вида", () => {
    expect(byText.get("рейхсканцлер Германии")).toMatchObject({ kind: "position", strong: true });
    expect(byText.get("фюрер")).toMatchObject({ kind: "position", strong: true });
    expect(byText.get("НСДАП")).toMatchObject({ kind: "fact", strong: true });
    expect(byText.get("Ева Браун")).toMatchObject({ kind: "fact", strong: true });
  });

  it("образование и место рождения — слабые", () => {
    expect(byText.get("Реальное училище в Линце")).toMatchObject({ kind: "education", strong: false });
    expect(byText.get("Браунау-ам-Инн")).toMatchObject({ kind: "birthPlace", strong: false });
  });

  it("родственник с фамилией субъекта признаком не становится — тёзка подтвердил бы сам себя", () => {
    expect(byText.has("Алоис Гитлер")).toBe(false);
  });

  it("больше восьми фраз карточка не даёт, сильные идут первыми", () => {
    const many: WikipediaStructuredFacts = {
      ...FACTS,
      facts: [
        ...Array.from({ length: 6 }, (_, i) => ({ property: "P19", kind: "birthPlace" as const, label: `Город номер ${i + 1}`, strong: false })),
        ...Array.from({ length: 6 }, (_, i) => ({ property: "P39", kind: "position" as const, label: `Должность номер ${i + 1}`, strong: true })),
      ],
    };
    const out = anchorsFromStructuredFacts(many, NAMES).phrases;
    expect(out).toHaveLength(8);
    expect(out.slice(0, 6).every((p) => p.strong)).toBe(true);
  });
});

describe("провайдер читает структуру по официальным API", () => {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  const answer = (url: string): unknown => {
    if (url.includes("ru.wikipedia.org/w/api.php") && url.includes("pageprops")) {
      return { query: { pages: [{ title: "Гитлер, Адольф", pageprops: { wikibase_item: "Q352" } }] } };
    }
    if (url.includes("wikidata.org/w/api.php") && url.includes("ids=Q352")) {
      return {
        entities: {
          Q352: {
            labels: { ru: { value: "Адольф Гитлер" }, en: { value: "Adolf Hitler" } },
            aliases: { en: [{ value: "Hitler" }] },
            claims: {
              P569: [{ mainsnak: { datavalue: { value: { time: "+1889-04-20T00:00:00Z", precision: 11 } } } }],
              P39: [{ mainsnak: { datavalue: { value: { id: "Q4970706" } } } }],
              P102: [{ mainsnak: { datavalue: { value: { id: "Q7320" } } } }],
              P19: [{ mainsnak: { datavalue: { value: { id: "Q1735" } } } }],
              P106: [{ mainsnak: { datavalue: { value: { id: "Q82955" } } } }],
            },
          },
        },
      };
    }
    if (url.includes("wikidata.org/w/api.php") && url.includes("props=labels")) {
      return {
        entities: {
          Q4970706: { labels: { ru: { value: "рейхсканцлер Германии" } } },
          Q7320: { labels: { ru: { value: "НСДАП" } } },
          Q1735: { labels: { ru: { value: "Браунау-ам-Инн" } } },
          Q82955: { labels: { ru: { value: "политик" } } },
        },
      };
    }
    throw new Error(`неожиданный адрес: ${url}`);
  };

  it("три вызова: pageprops, сущность, метки ссылочных сущностей; профессия не берётся", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify(answer(url)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    try {
      const facts = await new WikipediaProvider().structuredFacts({ language: "ru", title: "Гитлер, Адольф" });
      expect(facts?.itemId).toBe("Q352");
      expect(facts?.birthDate).toBe("1889-04-20");
      expect(facts?.facts.map((f) => `${f.kind}:${f.label}:${f.strong}`)).toEqual([
        "position:рейхсканцлер Германии:true",
        "fact:НСДАП:true",
        "birthPlace:Браунау-ам-Инн:false",
      ]);
      expect(facts?.aliases).toContain("Adolf Hitler");
      expect(calls).toHaveLength(3);
      expect(calls.every((u) => /^https:\/\/(ru\.wikipedia\.org|www\.wikidata\.org)\/w\/api\.php\?/u.test(u))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("профиль дела: структура сильнее прозы", () => {
  // Правка фикстуры после красного лога: хранилище профиля читает и пишет
  // через `read`/`write`, а не `load`/`save`.
  function memoryStore(): { store: SubjectProfileStore; read: () => unknown } {
    let saved: unknown = null;
    const store: SubjectProfileStore = {
      read: () => (saved as never) ?? null,
      write: (_caseId, profile) => { saved = profile; },
    };
    return { store, read: () => saved };
  }
  const card = {
    source: "wikipedia",
    cardId: "wikipedia:ru:Гитлер, Адольф",
    title: "Гитлер, Адольф",
    lead: "Адольф Гитлер — германский политик, основоположник и центральная фигура национал-социализма, фюрер Германского рейха.",
    leadRequested: true,
    snippet: "",
    articles: [{ language: "ru", title: "Гитлер, Адольф", url: "https://ru.wikipedia.org/wiki/Гитлер,_Адольф", lead: null, snippet: "" }],
  } as unknown as PersonaCard;

  it("со структурой прозаические слова с заглавной не берутся, дата ставится, когда у дела её нет", () => {
    const { store } = memoryStore();
    const result = applyCardAnchorsToProfile({
      caseId: "case-1",
      subjectName: "Адольф Гитлер",
      subjectDateOfBirth: null,
      card,
      structured: FACTS,
      store,
    });
    const phrases = result?.profile?.anchors?.phrases ?? [];
    expect(phrases.map((p) => p.text)).toContain("рейхсканцлер Германии");
    expect(phrases.map((p) => p.text)).not.toContain("Германского");
    expect(result?.profile?.anchors?.birthDate).toBe("1889-04-20");
    expect(result?.birthDateMismatch).toBeNull();
  });

  it("дата дела не переписывается, расхождение называется", () => {
    const { store } = memoryStore();
    const result = applyCardAnchorsToProfile({
      caseId: "case-1",
      subjectName: "Адольф Гитлер",
      subjectDateOfBirth: "1889-04-21",
      card,
      structured: FACTS,
      store,
    });
    expect(result?.profile?.anchors?.birthDate).toBe("1889-04-21");
    expect(result?.birthDateMismatch).toEqual({ card: "1889-04-20", subject: "1889-04-21" });
  });
});
