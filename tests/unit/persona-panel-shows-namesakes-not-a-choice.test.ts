import { describe, expect, it } from "vitest";
import {
  buildPersonaPanel,
  type PersonaPanelDeps,
  type PersonaWikipediaCard,
  type PersonaKnowledgeGraphCard,
  type PersonaSanctionsCard,
} from "@/modules/digital-profile/services/subject-persona-check";
import type { WikipediaNamesakeResult } from "@/modules/digital-profile/providers/wikipedia-provider";
import type { SerperSurfaceBatchResult } from "@/modules/digital-profile/providers/serper-surfaces";
import type { ComplianceScreeningResult } from "@/modules/digital-profile/compliance-providers/types";

/**
 * Панель отвечает на вопрос «кто ещё носит это имя», а отбор одной статьи
 * (`pickWikipediaCandidate`) отвечает на обратный — «какая из них наш
 * субъект». Отбор здесь был бы вторым ответом на вопрос принадлежности,
 * вынесенным из-под глаз оператора.
 */

const SUBJECT = {
  caseId: "case-persona-panel",
  fullName: "Петров Иван Иванович",
  aliases: [] as string[],
  dateOfBirth: "1970-03-05",
};

const RU_CANDIDATES = [
  {
    title: "Петровы",
    pageId: 15,
    snippet: "русская фамилия",
    url: "https://ru.wikipedia.org/wiki/Петровы",
    lead: "Петровы — русская фамилия.",
    leadRequested: true,
    langlinkTitle: null,
  },
  {
    title: "Петров, Иван Иванович (предприниматель)",
    pageId: 11,
    snippet: "предприниматель",
    url: "https://ru.wikipedia.org/wiki/Петров,_Иван_Иванович_(предприниматель)",
    lead: "Иван Иванович Петров (род. 5 марта 1970, Ленинград) — российский предприниматель.",
    leadRequested: true,
    langlinkTitle: "Ivan Petrov (businessman)",
  },
  {
    title: "Петров, Иван Иванович (футболист)",
    pageId: 12,
    snippet: "футболист",
    url: "https://ru.wikipedia.org/wiki/Петров,_Иван_Иванович_(футболист)",
    lead: "Иван Иванович Петров (род. 1 января 1988) — российский футболист.",
    leadRequested: true,
    langlinkTitle: null,
  },
  {
    title: "Петров, Иван Иванович (хоккеист)",
    pageId: 14,
    snippet: "хоккеист",
    url: "https://ru.wikipedia.org/wiki/Петров,_Иван_Иванович_(хоккеист)",
    lead: null,
    leadRequested: false,
    langlinkTitle: null,
  },
  {
    title: "Петров, Иван Иванович (учёный)",
    pageId: 13,
    snippet: "советский учёный",
    url: "https://ru.wikipedia.org/wiki/Петров,_Иван_Иванович_(учёный)",
    lead: null,
    leadRequested: false,
    langlinkTitle: null,
  },
];

const EN_CANDIDATES = [
  {
    title: "Ivan Petrov (businessman)",
    pageId: 21,
    snippet: "businessman",
    url: "https://en.wikipedia.org/wiki/Ivan_Petrov_(businessman)",
    lead: "Ivan Ivanovich Petrov (born 5 March 1970) is a Russian businessman.",
    leadRequested: true,
    langlinkTitle: "Петров, Иван Иванович (предприниматель)",
  },
  {
    title: "Ivan Petrov (bass)",
    pageId: 22,
    snippet: "opera singer",
    url: "https://en.wikipedia.org/wiki/Ivan_Petrov_(bass)",
    lead: "Ivan Petrov (1920—2003) was a Soviet opera singer.",
    leadRequested: true,
    langlinkTitle: null,
  },
];

function wikipediaSource(
  candidatesByLanguage: Record<string, typeof RU_CANDIDATES>
): NonNullable<PersonaPanelDeps["wikipedia"]> {
  return async ({ language }): Promise<WikipediaNamesakeResult> => ({
    language,
    query: language === "ru" ? SUBJECT.fullName : "Petrov Ivan Ivanovich",
    candidates: candidatesByLanguage[language] ?? [],
  });
}

const serperSource: NonNullable<PersonaPanelDeps["serper"]> = async (
  request,
  region
): Promise<SerperSurfaceBatchResult> => {
  const ru = region === "RU";
  return {
    status: "SUCCESS",
    items: [
      {
        kind: "knowledgePanel",
        query: request.query,
        region,
        language: "ru",
        rank: 1,
        title: ru ? "Иван Петров" : "Ivan Petrov",
        snippet: ru ? "Российский предприниматель" : "Russian businessman",
        url: "https://example.com/petrov",
        domain: "example.com",
        thumbnailUrl: "https://img.example.com/p.jpg",
        imageUrl: "https://img.example.com/p.jpg",
        videoUrl: null,
        sourcePageUrl: "https://example.com/petrov",
        rawMetadataSafe: { source: "serper", surface: "knowledgeGraph", capturedAt: "now" },
      },
      {
        kind: "knowledgePanel",
        query: request.query,
        region,
        language: "ru",
        rank: 1,
        title: "Ответ поисковой системы",
        snippet: "Иван Петров родился в 1970 году",
        url: null,
        domain: null,
        thumbnailUrl: null,
        imageUrl: null,
        videoUrl: null,
        sourcePageUrl: null,
        rawMetadataSafe: { source: "serper", surface: "answerBox", capturedAt: "now" },
      },
      {
        kind: "organic",
        query: request.query,
        region,
        language: "ru",
        rank: 1,
        title: "Иван Петров — биография",
        snippet: "…",
        url: ru ? "https://biography.example/petrov" : "https://who.example/petrov",
        domain: ru ? "biography.example" : "who.example",
        thumbnailUrl: null,
        imageUrl: null,
        videoUrl: null,
        sourcePageUrl: null,
        rawMetadataSafe: { source: "serper", surface: "organic", capturedAt: "now" },
      },
    ],
  };
};

const openSanctionsSource: NonNullable<PersonaPanelDeps["openSanctions"]> =
  async (): Promise<ComplianceScreeningResult> => ({
    status: "SUCCESS",
    provider: "OPEN_SANCTIONS",
    hits: [
      {
        provider: "OPEN_SANCTIONS",
        source: "OFFICIAL_API",
        subjectName: SUBJECT.fullName,
        matchedName: "Ivan Ivanovich Petrov",
        aliases: [],
        categories: ["sanction", "role.pep"],
        riskTypes: ["SANCTIONS", "PEP"],
        countries: ["ru"],
        datesOfBirth: ["1970-03-05"],
        matchScore: 91,
        confidence: "HIGH",
        profileId: "NK-abc",
        profileUrl: "https://www.opensanctions.org/entities/NK-abc/",
        summary: "темы: санкционные списки",
        rawMetadataSafe: { datasets: ["ru_sanctions"], score: 0.91 },
        reviewStatus: "PENDING",
      },
      {
        provider: "OPEN_SANCTIONS",
        source: "OFFICIAL_API",
        subjectName: SUBJECT.fullName,
        matchedName: "Ivan Petrov",
        aliases: [],
        categories: ["role.pep"],
        riskTypes: ["PEP"],
        countries: ["by"],
        datesOfBirth: ["1955-11-02"],
        matchScore: 78,
        confidence: "LOW",
        profileId: "NK-def",
        profileUrl: "https://www.opensanctions.org/entities/NK-def/",
        summary: "темы: публичные должностные лица (PEP)",
        rawMetadataSafe: { datasets: ["pep"], score: 0.78 },
        reviewStatus: "PENDING",
      },
    ],
  });

const allSources: PersonaPanelDeps = {
  wikipedia: wikipediaSource({ ru: RU_CANDIDATES, en: EN_CANDIDATES }),
  serper: serperSource,
  openSanctions: openSanctionsSource,
};

describe("панель показывает тёзок, а не выбирает за оператора", () => {
  it("в снимке все показанные кандидаты, в порядке источника и без пометки выбранного", async () => {
    const { snapshot } = await buildPersonaPanel({ subject: SUBJECT, deps: allSources });
    const wiki = snapshot.cards.filter(
      (c): c is PersonaWikipediaCard => c.source === "wikipedia"
    );
    // Первым идёт то, что вернул поиск, — страница-дизамбигуация «Петровы»,
    // которую отбор задвинул бы вниз или отбросил.
    expect(wiki.map((c) => c.title)).toEqual([
      "Петровы",
      "Петров, Иван Иванович (предприниматель)",
      "Петров, Иван Иванович (футболист)",
      "Петров, Иван Иванович (хоккеист)",
      "Петров, Иван Иванович (учёный)",
      "Ivan Petrov (bass)",
    ]);
    expect(JSON.stringify(snapshot)).not.toMatch(/"selected"\s*:\s*true/u);
  });

  it("русская и английская статьи склеиваются только по межъязыковой ссылке", async () => {
    const { snapshot } = await buildPersonaPanel({ subject: SUBJECT, deps: allSources });
    const merged = snapshot.cards.find(
      (c): c is PersonaWikipediaCard =>
        c.source === "wikipedia" && c.title === "Петров, Иван Иванович (предприниматель)"
    );
    expect(merged?.articles.map((a) => a.language)).toEqual(["ru", "en"]);
    expect(merged?.articles.map((a) => a.title)).toEqual([
      "Петров, Иван Иванович (предприниматель)",
      "Ivan Petrov (businessman)",
    ]);
    // Певец межъязыковой ссылки не имеет — он отдельный человек и отдельная карточка.
    const bass = snapshot.cards.find(
      (c): c is PersonaWikipediaCard => c.source === "wikipedia" && c.title === "Ivan Petrov (bass)"
    );
    expect(bass?.articles).toHaveLength(1);
  });

  it("без межъязыковой ссылки те же две статьи остаются двумя карточками", async () => {
    const noLanglink = RU_CANDIDATES.map((c) => ({ ...c, langlinkTitle: null }));
    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        ...allSources,
        wikipedia: wikipediaSource({
          ru: noLanglink,
          en: EN_CANDIDATES.map((c) => ({ ...c, langlinkTitle: null })),
        }),
      },
    });
    const titles = snapshot.cards
      .filter((c): c is PersonaWikipediaCard => c.source === "wikipedia")
      .map((c) => c.title);
    expect(titles).toContain("Петров, Иван Иванович (предприниматель)");
    expect(titles).toContain("Ivan Petrov (businessman)");
    expect(titles).toHaveLength(7);
  });

  it("панель знаний — отдельная карточка, а готовый ответ поисковика карточкой не становится", async () => {
    const { snapshot } = await buildPersonaPanel({ subject: SUBJECT, deps: allSources });
    const kg = snapshot.cards.filter(
      (c): c is PersonaKnowledgeGraphCard => c.source === "knowledge_graph"
    );
    // По одной карточке на каждую спрошенную форму имени: это две сущности
    // источника, а не одна, и склеивать их эвристикой панель не вправе.
    expect(kg.map((c) => c.title)).toEqual(["Иван Петров", "Ivan Petrov"]);
    expect(kg[0]?.imageUrl).toBe("https://img.example.com/p.jpg");
    expect(JSON.stringify(snapshot.cards)).not.toContain("Ответ поисковой системы");
  });

  it("выдача идёт вспомогательным блоком, а не карточками", async () => {
    const { snapshot } = await buildPersonaPanel({ subject: SUBJECT, deps: allSources });
    expect(snapshot.serpRows.map((r) => r.domain)).toEqual(["biography.example", "who.example"]);
    expect(snapshot.cards.some((c) => JSON.stringify(c).includes("biography.example"))).toBe(false);
  });

  it("записи санкционных списков идут в порядке провайдера, с датой и русскими темами", async () => {
    const { snapshot } = await buildPersonaPanel({ subject: SUBJECT, deps: allSources });
    const sanctions = snapshot.cards.filter(
      (c): c is PersonaSanctionsCard => c.source === "opensanctions"
    );
    expect(sanctions.map((c) => c.matchedName)).toEqual(["Ivan Ivanovich Petrov", "Ivan Petrov"]);
    expect(sanctions[0]?.datesOfBirth).toEqual(["1970-03-05"]);
    expect(sanctions[0]?.topicLabels).toEqual([
      "санкционные списки",
      "публичные должностные лица (PEP)",
    ]);
    expect(sanctions[0]?.matchScore).toBe(91);
    expect(sanctions[0]?.profileId).toBe("NK-abc");
  });

  it("подсветка даты есть только у структурной даты записи", async () => {
    const { snapshot } = await buildPersonaPanel({ subject: SUBJECT, deps: allSources });
    const sanctions = snapshot.cards.filter(
      (c): c is PersonaSanctionsCard => c.source === "opensanctions"
    );
    expect(sanctions[0]?.birthDateMatches).toBe(true);
    expect(sanctions[1]?.birthDateMatches).toBe(false);
    // Лид Википедии несёт дату прозой; парсер даты по прозе не заводится, и
    // поля подсветки у этих карточек нет вовсе.
    const wiki = snapshot.cards.find((c) => c.source === "wikipedia");
    expect(wiki).not.toHaveProperty("birthDateMatches");
  });

  it("введённая дата рождения печатается над карточками", async () => {
    const { snapshot } = await buildPersonaPanel({ subject: SUBJECT, deps: allSources });
    expect(snapshot.subjectDateOfBirth).toBe("1970-03-05");
    expect(snapshot.subjectFullName).toBe(SUBJECT.fullName);
  });

  it("в сохраняемом снимке нет ни ключей, ни служебных полей провайдеров", async () => {
    const { request, snapshot } = await buildPersonaPanel({ subject: SUBJECT, deps: allSources });
    const saved = JSON.stringify({ request, snapshot });
    expect(saved).not.toMatch(/api[_-]?key/iu);
    expect(saved).not.toMatch(/authorization/iu);
    expect(saved).not.toMatch(/rawMetadataSafe/u);
    expect(saved).not.toMatch(/opensanctions\.org\/match/u);
  });
});
