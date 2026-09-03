/**
 * AI-ответ поисковика — один на движок и регион, по запросу ФИО.
 *
 * Решение владельца (03.09.2026, В2 плана 0053): отчёту нужен только ответ
 * Алисы (Яндекс, Россия) и Google AI (Россия, ОАЭ) на само имя субъекта; в
 * отчёте 83 печаталось по ответу на каждый из 25 запросов, и страницы
 * множились. Какой запрос — само ФИО, знает план (`subjectNameQuery`), и
 * адаптер берёт ответы только по названным запросам.
 *
 * Строка-источник называется доменом: «Ответ поискового ИИ» четыре раза
 * подряд под одним ответом клиент читал как четыре копии ответа.
 */

import { describe, expect, it } from "vitest";
import { aiAnswersFromPositions } from "@/modules/digital-profile/providers/topvisor/adapters/ai-answers";
import { TOPVISOR_AUDIT_REGIONS } from "@/modules/digital-profile/providers/topvisor/regions";
import { loadTopvisorFixture } from "@/modules/digital-profile/providers/topvisor/fixtures/fixture-call";
import { runTopvisorPositionsTick } from "@/modules/digital-profile/services/topvisor-positions-tick";
import { createTopvisorFixtureCall, PILOT_KEYWORDS } from "@/modules/digital-profile/providers/topvisor/fixtures/fixture-call";
import { createMemoryTopvisorTaskStore } from "@/modules/digital-profile/providers/topvisor/task-store";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

const region = (key: string) => TOPVISOR_AUDIT_REGIONS.find((r) => r.key === key)!;
const PROVENANCE = {
  caseId: "case-1",
  unifiedJobId: "job-1",
  enrichmentRunId: "topvisor-positions-job-1",
  providerTaskId: "pt-1",
  externalTaskId: "32742967:2026-09-03",
};
const RU = ["Умар Кремлёв IBA", "Кремлёв федерация бокса"];

describe("адаптер AI-ответов", () => {
  it("берёт ответ только по названным запросам, и пустоту считает по ним же", () => {
    const all = aiAnswersFromPositions({
      body: loadTopvisorFixture("read-positions-correct"),
      region: region("yandex-moscow"),
      regionIndex: 1,
      queries: RU,
      provenance: PROVENANCE,
    });
    const bodies = (o: { url?: string; query?: string }[]) => o.filter((x) => !x.url);
    expect(bodies(all.observations).length).toBeGreaterThan(1);

    const one = aiAnswersFromPositions({
      body: loadTopvisorFixture("read-positions-correct"),
      region: region("yandex-moscow"),
      regionIndex: 1,
      queries: RU,
      answerQueries: ["Умар Кремлёв IBA"],
      provenance: PROVENANCE,
    });
    expect(bodies(one.observations).map((o) => o.query)).toEqual(["Умар Кремлёв IBA"]);
    expect(one.observations.every((o) => o.query === "Умар Кремлёв IBA")).toBe(true);
    expect(one.absentQueries).toEqual([]);

    const none = aiAnswersFromPositions({
      body: loadTopvisorFixture("read-positions-correct"),
      region: region("yandex-moscow"),
      regionIndex: 1,
      queries: RU,
      answerQueries: [],
      provenance: PROVENANCE,
    });
    expect(none.observations).toEqual([]);
  });

  it("строка-источник называется доменом, тело — движком", () => {
    const out = aiAnswersFromPositions({
      body: loadTopvisorFixture("read-positions-correct"),
      region: region("yandex-moscow"),
      regionIndex: 1,
      queries: RU,
      answerQueries: ["Умар Кремлёв IBA"],
      provenance: PROVENANCE,
    });
    const body = out.observations.find((o) => !o.url)!;
    const sources = out.observations.filter((o) => o.url);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      const host = new URL(s.url!).hostname.replace(/^www\./, "");
      expect(s.title).toBe(host);
    }
    expect(body.title).toBe("Ответ Алисы (Яндекс)");
    const google = aiAnswersFromPositions({
      body: loadTopvisorFixture("read-positions-correct"),
      region: region("google-dubai"),
      regionIndex: 2520,
      queries: ["Umar Kremlev investigation"],
      answerQueries: ["Umar Kremlev investigation"],
      provenance: PROVENANCE,
    });
    expect(google.observations.find((o) => !o.url)?.title).toBe("Ответ Google AI Overview");
  });
});

describe("тик Topvisor", () => {
  const ENV = { SERP_COLLECTION_PROVIDER: "topvisor", TOPVISOR_API_KEY: "k", TOPVISOR_USER_ID: "100001", TOPVISOR_SUGGEST_REGIONS: "none" };
  const job = (state: UnifiedCollectionJob["topvisorEnrichmentState"] = null) =>
    ({ caseId: "pilot-2026-09-03", unifiedJobId: "job-1", topvisorEnrichmentState: state }) as unknown as UnifiedCollectionJob;

  it("с планом ответы идут только по ФИО; без плана — по всем запросам", async () => {
    const drive = async (keywords: typeof PILOT_KEYWORDS & { plan?: Record<string, { purpose: string; subjectNameQuery?: boolean }> }) => {
      const { call } = createTopvisorFixtureCall({ projectExists: true, checkPollsUntilDone: 1 });
      const taskStore = createMemoryTopvisorTaskStore();
      let out = await runTopvisorPositionsTick({ job: job(), keywords, call, taskStore, env: ENV });
      for (let i = 0; i < 3 && out.state.phase !== "DONE"; i += 1) {
        out = await runTopvisorPositionsTick({ job: job(out.state), keywords, call, taskStore, env: ENV });
      }
      return out;
    };
    const withoutPlan = await drive(PILOT_KEYWORDS);
    const withPlan = await drive({
      ...PILOT_KEYWORDS,
      plan: {
        "RU|умар кремлёв iba": { purpose: "subject_lookup", subjectNameQuery: true },
        "UAE|umar kremlev investigation": { purpose: "subject_lookup", subjectNameQuery: true },
      },
    });
    const bodies = (o: typeof withPlan.observations) => o.filter((x) => x.surface === "ai_answer" && !x.url);
    expect(bodies(withoutPlan.observations).length).toBeGreaterThan(bodies(withPlan.observations).length);
    expect(new Set(bodies(withPlan.observations).map((o) => o.query))).toEqual(
      new Set(["Умар Кремлёв IBA", "Umar Kremlev investigation"])
    );
    expect(withPlan.state.aiAnswerCount).toBe(bodies(withPlan.observations).length);
    // По Google-Москве у ФИО ответа нет — пустота названа, а не молчит.
    expect(withPlan.state.aiAbsentQueries).toContain("google-moscow:Умар Кремлёв IBA");
  });
});
