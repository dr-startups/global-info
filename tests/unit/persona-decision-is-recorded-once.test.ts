import { describe, expect, it } from "vitest";
import {
  loadPersonaGateInput,
  personaGateState,
  recordPersonaCheck,
  recordPersonaDecision,
  subjectInputHash,
  type PersonaCheckPrisma,
  type PersonaCheckRow,
  type PersonaPanelSnapshot,
} from "@/modules/digital-profile/services/subject-persona-check";
import { AppError } from "@/modules/digital-profile/http/errors";

/**
 * Решение по строке неизменяемо: новое решение — только новой сборкой панели.
 * Ошибка в сторону строгости намеренная — «переголосовать» задним числом
 * означало бы, что оплаченный прогон стартовал по решению, которого уже нет.
 */

const CASE_ID = "case-persona-decision";
const SUBJECT = { fullName: "Петров Иван Иванович", aliases: [], dateOfBirth: "1970-03-05" };
const HASH = subjectInputHash(SUBJECT);

/** Единственная строка кейса и её решение — в памяти, без базы. */
function fakePrisma(): PersonaCheckPrisma & { rows: PersonaCheckRow[] } {
  const rows: PersonaCheckRow[] = [];
  let seq = 0;
  const matches = (row: PersonaCheckRow, where: Record<string, unknown> | undefined): boolean => {
    if (!where) return true;
    if (typeof where.id === "string" && row.id !== where.id) return false;
    if (typeof where.caseId === "string" && row.caseId !== where.caseId) return false;
    if (where.decision && typeof where.decision === "object") return row.decision !== null;
    return true;
  };
  return {
    rows,
    subjectPersonaCheck: {
      async create({ data }) {
        seq += 1;
        const row: PersonaCheckRow = {
          id: `check-${seq}`,
          caseId: String(data.caseId),
          subjectInputHash: String(data.subjectInputHash),
          requestJson: data.requestJson,
          personasJson: data.personasJson,
          fetchStatus: String(data.fetchStatus),
          errorCode: (data.errorCode as string | null) ?? null,
          searchedBy: (data.searchedBy as string | null) ?? null,
          searchedAt: new Date("2026-08-27T10:00:00.000Z"),
          decision: null,
          selectedPersonaJson: null,
          decidedBy: null,
          decidedAt: null,
        };
        rows.push(row);
        return row;
      },
      async findFirst(args) {
        const where = (args as { where?: Record<string, unknown> })?.where;
        return rows.filter((r) => matches(r, where)).at(-1) ?? null;
      },
      async findMany(args) {
        const where = (args as { where?: Record<string, unknown> })?.where;
        return rows.filter((r) => matches(r, where)).map((r) => ({ subjectInputHash: r.subjectInputHash }));
      },
      async update({ where, data }) {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error("row not found");
        Object.assign(row, data);
        return row;
      },
    },
  };
}

const WIKI_CARD = {
  source: "wikipedia" as const,
  cardId: "wikipedia:ru:Петров, Иван Иванович (предприниматель)",
  title: "Петров, Иван Иванович (предприниматель)",
  lead: "Иван Иванович Петров (род. 5 марта 1970) — предприниматель.",
  leadRequested: true,
  snippet: "предприниматель",
  articles: [
    {
      language: "ru",
      title: "Петров, Иван Иванович (предприниматель)",
      url: "https://ru.wikipedia.org/wiki/Петров,_Иван_Иванович_(предприниматель)",
      lead: "Иван Иванович Петров (род. 5 марта 1970) — предприниматель.",
      snippet: "предприниматель",
    },
    {
      language: "en",
      title: "Ivan Petrov (businessman)",
      url: "https://en.wikipedia.org/wiki/Ivan_Petrov_(businessman)",
      lead: "Ivan Ivanovich Petrov (born 5 March 1970) is a Russian businessman.",
      snippet: "businessman",
    },
  ],
};

const SANCTIONS_CARD = {
  source: "opensanctions" as const,
  cardId: "opensanctions:NK-abc",
  profileId: "NK-abc",
  profileUrl: "https://www.opensanctions.org/entities/NK-abc/",
  matchedName: "Ivan Ivanovich Petrov",
  datesOfBirth: ["1970-03-05"],
  topicLabels: ["санкционные списки"],
  matchScore: 91,
  birthDateMatches: true,
};

function snapshot(cards: PersonaPanelSnapshot["cards"], failed = false): PersonaPanelSnapshot {
  return {
    subjectFullName: SUBJECT.fullName,
    subjectDateOfBirth: SUBJECT.dateOfBirth,
    cards,
    serpRows: [],
    sources: [
      {
        source: "wikipedia",
        status: failed ? "FAILED" : "SUCCESS",
        code: failed ? "PROVIDER_REQUEST_FAILED" : null,
        detail: failed ? "HTTP 429" : null,
        waitedMs: null,
      },
      {
        source: "knowledge_graph",
        status: failed ? "NOT_CONFIGURED" : "SUCCESS",
        code: failed ? "PROVIDER_NOT_CONFIGURED" : null,
        detail: failed ? "Serper API key not configured" : null,
        waitedMs: null,
      },
      {
        source: "opensanctions",
        status: failed ? "FAILED" : "SUCCESS",
        code: failed ? "PROVIDER_REQUEST_FAILED" : null,
        detail: failed ? "HTTP 500" : null,
        waitedMs: null,
      },
    ],
    fetchStatus: failed ? "FAILED" : "SUCCESS",
    errorCode: failed ? "ALL_SOURCES_FAILED" : null,
  };
}

async function seed(
  prisma: PersonaCheckPrisma,
  cards: PersonaPanelSnapshot["cards"],
  failed = false
): Promise<PersonaCheckRow> {
  return recordPersonaCheck({
    caseId: CASE_ID,
    subjectInputHash: HASH,
    request: { terms: [SUBJECT.fullName], languages: ["ru", "en"], serperQueries: [], budgetMs: 20_000 },
    snapshot: snapshot(cards, failed),
    searchedBy: "operator-1",
    deps: { prisma },
  });
}

describe("решение записывается один раз и целиком", () => {
  it("выбор карточки пишет снимок с якорями, автора и время", async () => {
    const prisma = fakePrisma();
    const row = await seed(prisma, [WIKI_CARD, SANCTIONS_CARD]);
    const decided = await recordPersonaDecision({
      caseId: CASE_ID,
      checkId: row.id,
      decision: "PERSONA_SELECTED",
      selectedCardId: WIKI_CARD.cardId,
      decidedBy: "operator-1",
      deps: { prisma, now: () => new Date("2026-08-27T11:00:00.000Z") },
    });
    expect(decided.decision).toBe("PERSONA_SELECTED");
    expect(decided.decidedBy).toBe("operator-1");
    expect(decided.decidedAt).toEqual(new Date("2026-08-27T11:00:00.000Z"));
    const selected = decided.selectedPersonaJson as {
      source: string;
      anchors: { articles: Array<{ language: string; title: string; url: string }> };
      card: { cardId: string };
    };
    expect(selected.source).toBe("wikipedia");
    // Обязательство перед второй половиной: заголовки и адреса обоих языков.
    expect(selected.anchors.articles.map((a) => a.language)).toEqual(["ru", "en"]);
    expect(selected.anchors.articles.map((a) => a.url)).toEqual([
      "https://ru.wikipedia.org/wiki/Петров,_Иван_Иванович_(предприниматель)",
      "https://en.wikipedia.org/wiki/Ivan_Petrov_(businessman)",
    ]);
    expect(selected.card.cardId).toBe(WIKI_CARD.cardId);
  });

  it("у санкционной карточки якорь — идентификатор записи", async () => {
    const prisma = fakePrisma();
    const row = await seed(prisma, [WIKI_CARD, SANCTIONS_CARD]);
    const decided = await recordPersonaDecision({
      caseId: CASE_ID,
      checkId: row.id,
      decision: "PERSONA_SELECTED",
      selectedCardId: SANCTIONS_CARD.cardId,
      decidedBy: "operator-1",
      deps: { prisma },
    });
    expect(decided.selectedPersonaJson).toMatchObject({
      source: "opensanctions",
      anchors: { profileId: "NK-abc" },
    });
  });

  it("«различимой персоны нет» принимается и на строке, где все источники отказали", async () => {
    const prisma = fakePrisma();
    const row = await seed(prisma, [], true);
    const decided = await recordPersonaDecision({
      caseId: CASE_ID,
      checkId: row.id,
      decision: "APPROVED_WITHOUT_PERSONA",
      decidedBy: "operator-1",
      deps: { prisma },
    });
    expect(decided.decision).toBe("APPROVED_WITHOUT_PERSONA");
    expect(decided.selectedPersonaJson).toBeNull();
    // Причина пустоты по каждому источнику остаётся в строке решения — кодом,
    // который кабинет переводит в слова на своём языке.
    expect((decided.personasJson as PersonaPanelSnapshot).sources.map((s) => s.code)).toEqual([
      "PROVIDER_REQUEST_FAILED",
      "PROVIDER_NOT_CONFIGURED",
      "PROVIDER_REQUEST_FAILED",
    ]);
  });

  it("другое решение по той же строке отвергается", async () => {
    const prisma = fakePrisma();
    const row = await seed(prisma, [WIKI_CARD]);
    await recordPersonaDecision({
      caseId: CASE_ID,
      checkId: row.id,
      decision: "APPROVED_WITHOUT_PERSONA",
      decidedBy: "operator-1",
      deps: { prisma },
    });
    await expect(
      recordPersonaDecision({
        caseId: CASE_ID,
        checkId: row.id,
        decision: "PERSONA_SELECTED",
        selectedCardId: WIKI_CARD.cardId,
        decidedBy: "operator-2",
        deps: { prisma },
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("повтор того же решения подтверждает записанное, а не отказывает", async () => {
    /*
     * Аудит пишется после решения и падает сам по себе: решение записано,
     * оператор видит ошибку и жмёт ещё раз. Второй клик тем же ответом ничего
     * не меняет — отказывать на него значит показать отказ ворот там, где
     * ворота уже открыты.
     */
    const prisma = fakePrisma();
    const row = await seed(prisma, [WIKI_CARD]);
    const first = await recordPersonaDecision({
      caseId: CASE_ID,
      checkId: row.id,
      decision: "PERSONA_SELECTED",
      selectedCardId: WIKI_CARD.cardId,
      decidedBy: "operator-1",
      deps: { prisma, now: () => new Date("2026-08-27T11:00:00.000Z") },
    });
    const again = await recordPersonaDecision({
      caseId: CASE_ID,
      checkId: row.id,
      decision: "PERSONA_SELECTED",
      selectedCardId: WIKI_CARD.cardId,
      decidedBy: "operator-1",
      deps: { prisma, now: () => new Date("2026-08-27T11:05:00.000Z") },
    });
    expect(again.decision).toBe("PERSONA_SELECTED");
    // Время первого решения не переписывается: решение то же самое.
    expect(again.decidedAt).toEqual(first.decidedAt);
    expect(prisma.rows).toHaveLength(1);
  });

  it("повтор «без персоны» после отказа аудита тоже принимается", async () => {
    const prisma = fakePrisma();
    const row = await seed(prisma, [], true);
    await recordPersonaDecision({
      caseId: CASE_ID,
      checkId: row.id,
      decision: "APPROVED_WITHOUT_PERSONA",
      decidedBy: "operator-1",
      deps: { prisma },
    });
    const again = await recordPersonaDecision({
      caseId: CASE_ID,
      checkId: row.id,
      decision: "APPROVED_WITHOUT_PERSONA",
      decidedBy: "operator-1",
      deps: { prisma },
    });
    expect(again.decision).toBe("APPROVED_WITHOUT_PERSONA");
    expect(again.selectedPersonaJson).toBeNull();
  });

  it("повтор с другой карточкой — отказ: это другое решение", async () => {
    const prisma = fakePrisma();
    const row = await seed(prisma, [WIKI_CARD, SANCTIONS_CARD]);
    await recordPersonaDecision({
      caseId: CASE_ID,
      checkId: row.id,
      decision: "PERSONA_SELECTED",
      selectedCardId: WIKI_CARD.cardId,
      decidedBy: "operator-1",
      deps: { prisma },
    });
    await expect(
      recordPersonaDecision({
        caseId: CASE_ID,
        checkId: row.id,
        decision: "PERSONA_SELECTED",
        selectedCardId: SANCTIONS_CARD.cardId,
        decidedBy: "operator-1",
        deps: { prisma },
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("решение по чужому кейсу отвергается", async () => {
    const prisma = fakePrisma();
    const row = await seed(prisma, [WIKI_CARD]);
    const err = await recordPersonaDecision({
      caseId: "case-somebody-else",
      checkId: row.id,
      decision: "APPROVED_WITHOUT_PERSONA",
      decidedBy: "operator-2",
      deps: { prisma },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("NOT_FOUND");
    expect(prisma.rows[0]?.decision).toBeNull();
  });

  it("выбор карточки, которой на панели не было, отвергается", async () => {
    const prisma = fakePrisma();
    const row = await seed(prisma, [WIKI_CARD]);
    await expect(
      recordPersonaDecision({
        caseId: CASE_ID,
        checkId: row.id,
        decision: "PERSONA_SELECTED",
        selectedCardId: "wikipedia:ru:Кого-не-показывали",
        decidedBy: "operator-1",
        deps: { prisma },
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("автовыбора нет", () => {
  it("снимок с ровно одной карточкой оставляет ворота в PENDING", async () => {
    const prisma = fakePrisma();
    await seed(prisma, [WIKI_CARD]);
    const input = await loadPersonaGateInput(CASE_ID, {
      prisma,
      loadSubject: async () => ({
        caseId: CASE_ID,
        fullName: SUBJECT.fullName,
        aliases: [],
        targetRegions: ["RU"],
        location: null,
        dateOfBirth: SUBJECT.dateOfBirth,
        nationality: null,
        lawfulBasis: null,
        consentStatus: null,
        isFixture: false,
      }),
    });
    expect(input.decidedHashes).toEqual([]);
    expect(personaGateState(input).mode).toBe("PENDING");
  });

  it("после решения тот же загрузчик отдаёт хеш, и ворота открываются", async () => {
    const prisma = fakePrisma();
    const row = await seed(prisma, [WIKI_CARD]);
    await recordPersonaDecision({
      caseId: CASE_ID,
      checkId: row.id,
      decision: "PERSONA_SELECTED",
      selectedCardId: WIKI_CARD.cardId,
      decidedBy: "operator-1",
      deps: { prisma },
    });
    const input = await loadPersonaGateInput(CASE_ID, {
      prisma,
      loadSubject: async () => ({
        caseId: CASE_ID,
        fullName: SUBJECT.fullName,
        aliases: [],
        targetRegions: ["RU"],
        location: null,
        dateOfBirth: SUBJECT.dateOfBirth,
        nationality: null,
        lawfulBasis: null,
        consentStatus: null,
        isFixture: false,
      }),
    });
    expect(input.subjectInputHash).toBe(HASH);
    expect(input.decidedHashes).toEqual([HASH]);
    expect(personaGateState(input).mode).toBe("CONFIRMED");
  });
});
