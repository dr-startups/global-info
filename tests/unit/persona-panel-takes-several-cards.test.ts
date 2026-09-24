import { describe, expect, it } from "vitest";
import {
  personaDecisionForReport,
  recordPersonaDecision,
  type PersonaCheckPrisma,
  type PersonaCheckRow,
  type PersonaPanelSnapshot,
} from "@/modules/digital-profile/services/subject-persona-check";
import { AppError } from "@/modules/digital-profile/http/errors";
import { buildFrontMatterFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/front-matter";
import { DECK_TEMPLATE_REGISTRY, type DeckTemplateId } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { PersonaDecisionRecord, ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { SelfCheckPersonaDecisionSchema } from "@/modules/self-check/schemas";
import { togglePickedCard } from "@/modules/site/check/persona-view";

/**
 * В «Это вы?» можно отметить несколько карточек одного человека.
 *
 * У публичного лица статья Википедии и запись OpenSanctions — один человек, а
 * выбрать можно было одну: «Это я» сразу запускало проверку (предложение
 * владельца 24.09.2026). Выбор на сбор и вердикт не влияет — он записывается для
 * аналитика и печатается на листе «Кого проверяли», поэтому все отмеченные
 * карточки обязаны дойти до записи и до листа.
 */

const WIKI_ID = "wikipedia:ru:Петров, Иван Иванович";
const SANCTIONS_ID = "opensanctions:NK-petrov";
const KG_ID = "knowledge_graph:RU:Иван Петров";

const SNAPSHOT: PersonaPanelSnapshot = {
  subjectFullName: "Петров Иван Иванович",
  subjectDateOfBirth: "1970-03-05",
  cards: [
    {
      source: "wikipedia",
      cardId: WIKI_ID,
      title: "Петров, Иван Иванович",
      lead: "российский предприниматель",
      leadRequested: true,
      snippet: "",
      articles: [{ language: "ru", title: "Петров, Иван Иванович", url: "https://ru.wikipedia.org/wiki/Петров", lead: null, snippet: "" }],
    },
    {
      source: "opensanctions",
      cardId: SANCTIONS_ID,
      profileId: "NK-petrov",
      profileUrl: "https://www.opensanctions.org/entities/NK-petrov/",
      matchedName: "Ivan Ivanovich Petrov",
      datesOfBirth: ["1970-03-05"],
      topicLabels: ["санкционные списки"],
      matchScore: 0.9,
      birthDateMatches: true,
    },
    {
      source: "knowledge_graph",
      cardId: KG_ID,
      title: "Иван Петров",
      description: "Предприниматель",
      imageUrl: null,
      url: "https://example.org/petrov",
      query: "Петров Иван Иванович",
      region: "RU",
    },
  ],
  serpRows: [],
  sources: [
    { source: "wikipedia", status: "SUCCESS", code: null, detail: null, waitedMs: null },
    { source: "knowledge_graph", status: "SUCCESS", code: null, detail: null, waitedMs: null },
    { source: "opensanctions", status: "SUCCESS", code: null, detail: null, waitedMs: null },
  ],
  fetchStatus: "SUCCESS",
  errorCode: null,
} as unknown as PersonaPanelSnapshot;

function store(selectedPersonaJson: unknown = null, decision: string | null = null) {
  const row: PersonaCheckRow = {
    id: "check-1",
    caseId: "case-1",
    subjectInputHash: "hash",
    requestJson: {},
    personasJson: SNAPSHOT,
    fetchStatus: "SUCCESS",
    errorCode: null,
    searchedBy: "self-check:check-1",
    searchedAt: new Date("2026-09-24T10:00:00Z"),
    decision,
    selectedPersonaJson,
    decidedBy: null,
    decidedAt: decision ? new Date("2026-09-24T10:01:00Z") : null,
  };
  const prisma: PersonaCheckPrisma = {
    subjectPersonaCheck: {
      create: async () => row,
      findFirst: async () => row,
      findMany: async () => [],
      update: async ({ data }) => Object.assign(row, data),
    },
  };
  return { row, deps: { prisma, now: () => new Date("2026-09-24T10:01:00Z") } };
}

async function decide(ids: string[] | undefined, s = store()) {
  return recordPersonaDecision({
    caseId: "case-1",
    checkId: "check-1",
    decision: "PERSONA_SELECTED",
    selectedCardIds: ids,
    decidedBy: "self-check:check-1",
    deps: s.deps,
  });
}

async function refusal(run: () => Promise<unknown>): Promise<number | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err instanceof AppError ? err.status : -1;
  }
}

describe("решение с несколькими карточками", () => {
  it("записывает все отмеченные карточки, и снимок отчёта их называет", async () => {
    const row = await decide([SANCTIONS_ID, WIKI_ID]);
    const record = personaDecisionForReport(row)!;
    expect(record.decision).toBe("PERSONA_SELECTED");
    expect(record.selected.map((c) => c.title).sort()).toEqual(["Ivan Ivanovich Petrov", "Петров, Иван Иванович"]);
  });

  it("тот же набор в другом порядке — тот же ответ, другой набор — отказ", async () => {
    const s = store();
    await decide([WIKI_ID, SANCTIONS_ID], s);
    expect(await refusal(() => decide([SANCTIONS_ID, WIKI_ID], s))).toBeNull();
    expect(await refusal(() => decide([WIKI_ID], s))).toBe(409);
  });

  it("карточки нет в панели — отказ; «это я» без единой карточки — отказ", async () => {
    expect(await refusal(() => decide([WIKI_ID, "wikipedia:ru:Чужой"]))).toBe(400);
    expect(await refusal(() => decide([]))).toBe(400);
  });

  it("запись старого вида (одна карточка) читается как одна карточка", () => {
    const card = SNAPSHOT.cards[0]!;
    const { row } = store({ source: card.source, anchors: {}, card }, "PERSONA_SELECTED");
    expect(personaDecisionForReport(row)!.selected.map((c) => c.title)).toEqual(["Петров, Иван Иванович"]);
  });
});

const SCOPED = {
  subject: { displayName: "Иван Петров", aliases: [] },
  findings: [],
  surfaceUnits: [],
  evidenceIndex: {},
  scope: { regions: null, surfaces: null, subjectMatch: null, findingIds: null },
  metricSnapshot: {},
} as unknown as ScopedFragmentInput;

function personaNarrative(record: PersonaDecisionRecord): { narrative: string; budget: number } {
  const out = buildFrontMatterFragment("FRONT_MATTER", SCOPED, { personaDecision: record } as FragmentExtras);
  const slide = out.slides.find((s) => s.baseSlotId === "p03_persona")!;
  return {
    narrative: String(slide.content.narrative ?? ""),
    budget: DECK_TEMPLATE_REGISTRY[slide.templateId as DeckTemplateId].layout.narrativeCharBudget,
  };
}

const SOURCES = SNAPSHOT.sources.map((s) => ({ source: s.source, status: s.status }));

describe("лист «Кого проверяли» называет все отмеченные карточки", () => {
  it("две карточки — обе по имени и с адресами", () => {
    const { narrative } = personaNarrative({
      decision: "PERSONA_SELECTED",
      selected: [
        { source: "wikipedia", title: "Петров, Иван Иванович", url: "https://ru.wikipedia.org/wiki/Петров", datesOfBirth: [] },
        { source: "opensanctions", title: "Ivan Ivanovich Petrov", url: "https://www.opensanctions.org/entities/NK-petrov/", datesOfBirth: ["1970-03-05"] },
      ],
      sources: SOURCES,
      cardCount: 3,
      decidedAt: "2026-09-24T10:01:00.000Z",
    });
    expect(narrative).toContain("«Петров, Иван Иванович»");
    expect(narrative).toContain("«Ivan Ivanovich Petrov»");
    expect(narrative).toMatch(/ru\.wikipedia\.org/u);
    expect(narrative).toMatch(/opensanctions\.org/u);
    expect(narrative).toMatch(/одного человека/u);
  });

  it("много длинных карточек — лист называет, сколько не поместилось, и влезает в бюджет с запасом", () => {
    const long = (i: number) => ({
      source: "opensanctions",
      title: `Petrov Ivan Ivanovich Aleksandrovich Very Long Registry Name Variant ${i}`,
      url: `https://www.opensanctions.org/entities/NK-very-long-identifier-of-the-sanctions-record-${i}/`,
      datesOfBirth: ["1970-03-05", "1970-03-06", "1971-01-01"],
    });
    const { narrative, budget } = personaNarrative({
      decision: "PERSONA_SELECTED",
      selected: [long(1), long(2), long(3), long(4), long(5)],
      sources: SOURCES,
      cardCount: 12,
      decidedAt: "2026-09-24T10:01:00.000Z",
    });
    expect(narrative).toMatch(/ещё 3/u);
    expect(narrative.length, `абзац ${narrative.length} против бюджета ${budget}`).toBeLessThan(budget * 0.75);
  });
});

describe("ручка сайта и отметка карточки", () => {
  it("тело с несколькими карточками и прежнее тело с одной читаются одним списком", () => {
    expect(
      SelfCheckPersonaDecisionSchema.parse({ decision: "PERSONA_SELECTED", selectedCardIds: [WIKI_ID, SANCTIONS_ID] })
        .selectedCardIds
    ).toEqual([WIKI_ID, SANCTIONS_ID]);
    expect(
      SelfCheckPersonaDecisionSchema.parse({ decision: "PERSONA_SELECTED", selectedCardId: WIKI_ID }).selectedCardIds
    ).toEqual([WIKI_ID]);
    expect(SelfCheckPersonaDecisionSchema.safeParse({ decision: "PERSONA_SELECTED", selectedCardIds: [] }).success).toBe(false);
  });

  it("повторное нажатие «Это я» снимает отметку, остальные остаются", () => {
    const one = togglePickedCard([], WIKI_ID);
    const two = togglePickedCard(one, SANCTIONS_ID);
    expect(two).toEqual([WIKI_ID, SANCTIONS_ID]);
    expect(togglePickedCard(two, WIKI_ID)).toEqual([SANCTIONS_ID]);
  });
});
