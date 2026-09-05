import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import {
  personaDecisionForReport,
  type PersonaCheckRow,
} from "@/modules/digital-profile/services/subject-persona-check";

/**
 * Проводка решения о персоне от базы до входов деки.
 *
 * Тесты самой страницы подают снимок руками и пропажу проводки не заметят: до
 * этой работы решение лежало в базе целиком, а `runCanonicalReportPrepare` о
 * базе не знает вовсе. Здесь проверяются два стыка — снятие снимка со строки и
 * чтение артефакта прогона.
 */

const SANCTIONS_CARD = {
  source: "opensanctions" as const,
  cardId: "opensanctions:NK-7fQ2",
  profileId: "NK-7fQ2",
  profileUrl: "https://www.opensanctions.org/entities/NK-7fQ2/",
  matchedName: "Umar Nazarovich Kremlev",
  datesOfBirth: ["1982-06-05"],
  topicLabels: ["Политически значимое лицо"],
  matchScore: 0.93,
  birthDateMatches: true,
};

const WIKI_CARD = {
  source: "wikipedia" as const,
  cardId: "wikipedia:ru:Кремлёв, Умар Назарович",
  title: "Кремлёв, Умар Назарович",
  lead: "Умар Назарович Кремлёв (род. 5 июня 1982, Серпухов) — российский спортивный функционер.",
  leadRequested: true,
  snippet: "Российский спортивный функционер.",
  articles: [
    {
      language: "ru",
      title: "Кремлёв, Умар Назарович",
      url: "https://ru.wikipedia.org/wiki/Кремлёв,_Умар_Назарович",
      lead: "Умар Назарович Кремлёв (род. 5 июня 1982, Серпухов) — российский спортивный функционер.",
      snippet: "Российский спортивный функционер.",
    },
  ],
};

const SOURCES = [
  { source: "wikipedia", status: "SUCCESS", code: null, detail: null, waitedMs: null },
  { source: "knowledge_graph", status: "NOT_CONFIGURED", code: "PROVIDER_NOT_CONFIGURED", detail: null, waitedMs: null },
  { source: "opensanctions", status: "SUCCESS", code: null, detail: null, waitedMs: null },
];

function row(overrides: Partial<PersonaCheckRow>): PersonaCheckRow {
  return {
    id: "check-1",
    caseId: "case-persona",
    subjectInputHash: "hash-1",
    requestJson: {},
    personasJson: {
      subjectFullName: "Кремлёв Умар Назарович",
      subjectDateOfBirth: "1982-06-05",
      cards: [WIKI_CARD, SANCTIONS_CARD],
      serpRows: [],
      sources: SOURCES,
      fetchStatus: "SUCCESS",
      errorCode: null,
    },
    fetchStatus: "SUCCESS",
    errorCode: null,
    searchedBy: "operator@example.com",
    searchedAt: new Date("2026-08-20T08:00:00.000Z"),
    decision: null,
    selectedPersonaJson: null,
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

describe("снимок решения о персоне для отчёта", () => {
  it("кейса без строки панели решения не имеет", () => {
    expect(personaDecisionForReport(null)).toBeNull();
  });

  it("собранная, но нерешённая панель решением не считается", () => {
    expect(personaDecisionForReport(row({}))).toBeNull();
  });

  it("выбранная запись санкционного списка несёт источник, заголовок, адрес и структурную дату", () => {
    const record = personaDecisionForReport(
      row({
        decision: "PERSONA_SELECTED",
        selectedPersonaJson: { source: "opensanctions", anchors: {}, card: SANCTIONS_CARD },
        decidedBy: "operator@example.com",
        decidedAt: new Date("2026-08-20T09:00:00.000Z"),
      })
    );
    expect(record?.decision).toBe("PERSONA_SELECTED");
    expect(record?.selected).toEqual({
      source: "opensanctions",
      title: "Umar Nazarovich Kremlev",
      url: "https://www.opensanctions.org/entities/NK-7fQ2/",
      datesOfBirth: ["1982-06-05"],
    });
  });

  it("дата рождения берётся только структурная — лид статьи в снимок не едет", () => {
    const record = personaDecisionForReport(
      row({
        decision: "PERSONA_SELECTED",
        selectedPersonaJson: { source: "wikipedia", anchors: {}, card: WIKI_CARD },
        decidedAt: new Date("2026-08-20T09:00:00.000Z"),
      })
    );
    expect(record?.selected?.datesOfBirth).toEqual([]);
    // Прозаический лид «(род. 5 июня 1982…)» не разбирается и не пересказывается:
    // неверно разобранная дата рядом с именем — тихая ложь о человеке.
    expect(JSON.stringify(record)).not.toContain("род. 5 июня 1982");
  });

  it("оценка совпадения в снимок отчёта не попадает", () => {
    const record = personaDecisionForReport(
      row({
        decision: "PERSONA_SELECTED",
        selectedPersonaJson: { source: "opensanctions", anchors: {}, card: SANCTIONS_CARD },
        decidedAt: new Date("2026-08-20T09:00:00.000Z"),
      })
    );
    expect(JSON.stringify(record)).not.toContain("0.93");
    expect(JSON.stringify(record)).not.toContain("matchScore");
  });

  it("решение без персоны несёт состояние источников и число показанных карточек", () => {
    const record = personaDecisionForReport(
      row({
        decision: "APPROVED_WITHOUT_PERSONA",
        selectedPersonaJson: null,
        decidedAt: new Date("2026-08-20T09:00:00.000Z"),
      })
    );
    expect(record?.decision).toBe("APPROVED_WITHOUT_PERSONA");
    expect(record?.selected).toBeNull();
    expect(record?.cardCount).toBe(2);
    // Причина отказа едет вместе с состоянием (шаг 0057): без неё лист «Кого
    // проверяли» называл словами то, чего не наблюдал, — «источник не ответил»
    // там, где источник ответил отказом.
    expect(record?.sources).toEqual([
      { source: "wikipedia", status: "SUCCESS" },
      { source: "knowledge_graph", status: "NOT_CONFIGURED", code: "PROVIDER_NOT_CONFIGURED" },
      { source: "opensanctions", status: "SUCCESS" },
    ]);
  });
});

describe("артефакт решения о персоне на входе деки", () => {
  function analyticsDir(artifact?: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), "deck-persona-"));
    const write = (name: string, value: unknown): void => {
      writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
    };
    write("verified-finding-bundle.json", { findings: [] });
    write("ambiguous-findings.json", []);
    write("surface-analysis.json", {});
    write("executive-summary.json", {});
    write("report-data-binding.json", {
      baseReportRunId: "run-1",
      datasetId: "ds-1",
      caseId: "case-persona",
    });
    write("provider-delta.json", { baseCount: 0, arsenkinObservationCount: 0 });
    write("composite-serp-observations.json", { observations: [], baseCount: 0, compositeCount: 0 });
    write("subject-resolution.json", { items: [] });
    if (artifact !== undefined) write("persona-decision.json", artifact);
    return dir;
  }

  it("артефакта нет — это не ошибка сборки, а отсутствие решения", () => {
    expect(loadDeckInputsFromAnalyticsDir(analyticsDir()).personaDecision).toBeNull();
  });

  it("артефакт без решения решения не создаёт", () => {
    const dir = analyticsDir({
      version: "persona-decision-v1",
      caseId: "case-persona",
      note: "Решения по персоне у кейса нет.",
      record: null,
    });
    expect(loadDeckInputsFromAnalyticsDir(dir).personaDecision).toBeNull();
  });

  it("записанное решение доезжает до входов деки целиком", () => {
    const record = {
      decision: "PERSONA_SELECTED",
      selected: {
        source: "opensanctions",
        title: "Umar Nazarovich Kremlev",
        url: "https://www.opensanctions.org/entities/NK-7fQ2/",
        datesOfBirth: ["1982-06-05"],
      },
      sources: [{ source: "wikipedia", status: "SUCCESS" }],
      cardCount: 2,
      decidedAt: "2026-08-20T09:00:00.000Z",
    };
    const dir = analyticsDir({
      version: "persona-decision-v1",
      caseId: "case-persona",
      note: "Оператор выбрал персону до начала сбора.",
      record,
    });
    expect(loadDeckInputsFromAnalyticsDir(dir).personaDecision).toEqual(record);
  });
});
