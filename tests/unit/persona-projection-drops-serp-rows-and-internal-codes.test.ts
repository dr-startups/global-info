import { describe, expect, it } from "vitest";
import { publicPersonaPanel } from "@/modules/self-check/public-dto";
import { personaCheckRow } from "../support/self-check-fakes";

/**
 * Посетитель видит карточки панели персоны, а не снимок целиком.
 *
 * Снимок панели написан для оператора: в нём строки выдачи со ссылками и
 * доменами, коды причин, подробности провайдеров («HTTP 429»), время
 * ожидания и оценка совпадения. Решение заказчика 11.09 — посетителю ни
 * ссылок, ни доменов; исключение — статья Википедии: это публичная
 * энциклопедия о человеке, и её посетитель узнаёт глазами.
 */

const snapshot = {
  subjectFullName: "Иванов Иван Иванович",
  subjectDateOfBirth: "1985-03-12",
  cards: [
    {
      source: "wikipedia",
      cardId: "wikipedia:ru:Иванов, Иван Иванович",
      title: "Иванов, Иван Иванович",
      lead: "Л".repeat(400),
      leadRequested: true,
      snippet: "российский предприниматель",
      articles: [
        {
          language: "ru",
          title: "Иванов, Иван Иванович",
          url: "https://ru.wikipedia.org/wiki/Иванов,_Иван_Иванович",
          lead: null,
          snippet: "",
        },
      ],
    },
    {
      source: "knowledge_graph",
      cardId: "knowledge_graph:RU:Иван Иванов",
      title: "Иван Иванов",
      description: "Российский предприниматель",
      imageUrl: "http://images.example/photo.jpg",
      url: "https://kg-link.example/ivanov",
      query: "Иванов Иван Иванович",
      region: "RU",
    },
    {
      source: "knowledge_graph",
      cardId: "knowledge_graph:RU:Иван Иванов (2)",
      title: "Иван Иванов",
      description: "Хоккеист",
      imageUrl: "https://images.example/secure.jpg",
      url: null,
      query: "Иванов Иван Иванович",
      region: "RU",
    },
    {
      source: "opensanctions",
      cardId: "opensanctions:NK-abc",
      profileId: "NK-abc",
      profileUrl: "https://www.opensanctions.org/entities/NK-abc/",
      matchedName: "IVANOV Ivan",
      datesOfBirth: ["1985-03-12"],
      topicLabels: ["Санкции", "PEP"],
      matchScore: 0.87,
      birthDateMatches: true,
    },
  ],
  serpRows: [{ title: "Иванов на сайте", url: "https://serp-row.example/ivanov", domain: "serp-row.example" }],
  sources: [
    { source: "wikipedia", status: "SUCCESS", code: null, detail: null, waitedMs: null },
    { source: "knowledge_graph", status: "FAILED", code: "PROVIDER_REQUEST_FAILED", detail: "HTTP 429", waitedMs: null },
    { source: "opensanctions", status: "TIMEOUT", code: "PERSONA_PANEL_BUDGET_EXCEEDED", detail: null, waitedMs: 20_000 },
  ],
  fetchStatus: "SUCCESS",
  errorCode: null,
};

const row = personaCheckRow({
  id: "persona-7",
  personasJson: snapshot,
  requestJson: { terms: ["Иванов Иван Иванович"], serperQueries: [{ query: "Иванов Иван Иванович", region: "RU" }] },
  searchedBy: "self-check:check-1",
  subjectInputHash: "subject-input-hash-value",
});

const out = publicPersonaPanel(row);
const json = JSON.stringify(out);

describe("проекция панели персоны", () => {
  it("строк выдачи в ответе нет вовсе", () => {
    expect(out).not.toHaveProperty("serpRows");
    expect(json).not.toContain("serp-row.example");
  });

  it("кодов причин, подробностей провайдера, ожидания и служебных полей нет", () => {
    for (const leak of [
      "PROVIDER_REQUEST_FAILED",
      "PERSONA_PANEL_BUDGET_EXCEEDED",
      "HTTP 429",
      "waitedMs",
      "20000",
      "self-check:check-1",
      "subject-input-hash-value",
      "serperQueries",
      "matchScore",
      "0.87",
      "profileUrl",
      "opensanctions.org",
      "kg-link.example",
    ]) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it("состояние источника — словом", () => {
    expect(out.sources).toEqual([
      { source: "wikipedia", status: "ok" },
      { source: "knowledge_graph", status: "unavailable" },
      { source: "opensanctions", status: "timeout" },
    ]);
    const other = publicPersonaPanel(
      personaCheckRow({
        personasJson: {
          ...snapshot,
          sources: [
            { source: "knowledge_graph", status: "NOT_CONFIGURED", code: "PROVIDER_NOT_CONFIGURED", detail: "no key", waitedMs: null },
            { source: "opensanctions", status: "OFFLINE", code: "NETWORK_CALLS_DISABLED", detail: null, waitedMs: null },
          ],
        },
      })
    );
    expect(other.sources).toEqual([
      { source: "knowledge_graph", status: "not_configured" },
      { source: "opensanctions", status: "unavailable" },
    ]);
  });

  it("ссылка — только у статьи Википедии", () => {
    expect(out.cards.map((c) => c.url)).toEqual([
      "https://ru.wikipedia.org/wiki/Иванов,_Иван_Иванович",
      null,
      null,
      null,
    ]);
  });

  it("фотография — только по https", () => {
    expect(out.cards[1]!.imageUrl).toBeNull();
    expect(out.cards[2]!.imageUrl).toBe("https://images.example/secure.jpg");
  });

  it("описание не длиннее 300 знаков", () => {
    expect(out.cards[0]!.description!.length).toBeLessThanOrEqual(300);
    expect(out.cards[1]!.description).toBe("Российский предприниматель");
  });

  it("санкционная карточка — имя, даты рождения, совпадение даты и темы", () => {
    expect(out.cards[3]).toEqual({
      cardId: "opensanctions:NK-abc",
      source: "opensanctions",
      title: "IVANOV Ivan",
      description: "Санкции, PEP",
      imageUrl: null,
      url: null,
      birthDates: ["1985-03-12"],
      birthDateMatches: true,
    });
  });

  it("совпадение даты рождения бывает только у санкционной карточки", () => {
    for (const card of out.cards.slice(0, 3)) {
      expect(card.birthDates).toEqual([]);
      expect(card.birthDateMatches).toBe(false);
    }
  });

  it("решения нет — null; решение есть — ответ, карточка и время, без автора", () => {
    expect(out.decision).toBeNull();
    expect(out.checkId).toBe("persona-7");
    const decided = publicPersonaPanel(
      personaCheckRow({
        personasJson: snapshot,
        decision: "PERSONA_SELECTED",
        selectedPersonaJson: { source: "opensanctions", anchors: {}, card: snapshot.cards[3] },
        decidedBy: "self-check:check-1",
        decidedAt: new Date("2026-09-14T10:05:00Z"),
      })
    );
    expect(decided.decision).toEqual({
      decision: "PERSONA_SELECTED",
      selectedCardId: "opensanctions:NK-abc",
      decidedAt: new Date("2026-09-14T10:05:00Z"),
    });
    expect(JSON.stringify(decided)).not.toContain("self-check:check-1");
  });
});
