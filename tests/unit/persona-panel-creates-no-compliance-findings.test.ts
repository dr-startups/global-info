import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Панель отвечает «про кого собирать», скрининг 04.3 — «есть ли совпадение по
 * спискам». Вопросы разные, и владелец находок один: скрининг прогона. Если
 * срез панели пойдёт через `runComplianceScreening`, он заведёт
 * `ComplianceScreeningRun`, запишет `DatabaseProfile` на каждое совпадение и
 * родит находку — то есть ответит на чужой вопрос ещё до первой траты.
 */

const screeningCalls: string[] = [];
vi.mock("@/modules/digital-profile/compliance-providers/service", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    runComplianceScreening: async (input: { caseId?: string }) => {
      screeningCalls.push(String(input?.caseId ?? "?"));
      throw new Error("панель комплаенс-скрининг не запускает");
    },
  };
});

import { buildPersonaPanel } from "@/modules/digital-profile/services/subject-persona-check";
import type { PersonaSanctionsCard } from "@/modules/digital-profile/services/subject-persona-check";

const SUBJECT = {
  caseId: "case-persona-compliance",
  fullName: "Петров Иван Иванович",
  aliases: [] as string[],
  dateOfBirth: "1970-03-05",
};

const MATCH_PAYLOAD = {
  responses: {
    subject: {
      results: [
        {
          id: "NK-abc",
          caption: "Ivan Ivanovich Petrov",
          score: 0.91,
          schema: "Person",
          datasets: ["ru_sanctions"],
          properties: {
            name: ["Ivan Ivanovich Petrov"],
            topics: ["sanction", "role.pep"],
            birthDate: ["1970-03-05"],
          },
        },
      ],
    },
  },
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  screeningCalls.length = 0;
});

describe("панель не рождает комплаенс-находок", () => {
  it("срез идёт прямым вызовом провайдера, минуя скрининг прогона", async () => {
    /*
     * Вето снято намеренно и ровно на один вызов: проверяется, кого зовёт
     * умолчание источника. Сетью это не является — `fetch` подменён, наружу
     * не уходит ни одного байта (тот же приём, что у `media-asset-svg`).
     */
    vi.stubEnv("NETWORK_CALLS", "1");
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(MATCH_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const { snapshot } = await buildPersonaPanel({
      subject: SUBJECT,
      deps: {
        wikipedia: async ({ language }) => ({ language, query: "q", candidates: [] }),
        serper: async () => ({ status: "SUCCESS", items: [] }),
      },
    });

    expect(screeningCalls).toEqual([]);
    expect(urls.filter((u) => u.includes("/match/"))).toHaveLength(1);
    const sanctions = snapshot.cards.filter(
      (c): c is PersonaSanctionsCard => c.source === "opensanctions"
    );
    expect(sanctions.map((c) => c.matchedName)).toEqual(["Ivan Ivanovich Petrov"]);
    expect(snapshot.sources.find((s) => s.source === "opensanctions")?.status).toBe("SUCCESS");
  });

  it("сервис не знает ни скрининга прогона, ни его записей", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      "src/modules/digital-profile/services/subject-persona-check.ts",
      "utf8"
    );
    for (const forbidden of [
      "runComplianceScreening",
      "persistComplianceHit",
      "syncComplianceRiskFinding",
      "complianceScreeningRun",
      "databaseProfile",
      "riskFinding",
    ]) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
