/**
 * Map Arsenkin check-top / suggest / paa fixtures → SerpObservation drafts.
 *
 *   npm run smoke:arsenkin-adapters
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  buildCheckTopRequest,
  mapCheckTopToObservations,
  buildSuggestRequest,
  mapSuggestToObservations,
  buildPaaRequest,
  mapPaaToObservations,
  buildAiSerpRequest,
  mapAiSerpToObservations,
  ARSENKIN_REGION,
  pilotSeForRegion,
} from "../src/modules/digital-profile/providers/arsenkin";

const FIX = join(process.cwd(), "src/modules/digital-profile/providers/arsenkin/fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf-8"));
}

async function main() {
  const se = pilotSeForRegion("RU");
  const topReq = buildCheckTopRequest({
    queries: ["Глинка Сергей Михайлович"],
    se,
    depth: 10,
    is_snippet: true,
  });
  assert.equal(topReq.tools_name, "check-top");

  const top = mapCheckTopToObservations({
    caseId: "case-1",
    auditRunId: "run-1",
    regionLabel: "RU",
    language: "ru",
    queries: ["Глинка Сергей Михайлович"],
    se: [{ type: 2, region: ARSENKIN_REGION.YANDEX_MOSCOW }],
    payload: load("get-check-top.json"),
  });
  assert.ok(top.length >= 2, `expected organic rows, got ${top.length}`);
  assert.equal(top[0]?.provider, "arsenkin");
  assert.equal(top[0]?.surface, "organic");
  assert.ok(top.every((d) => d.queryText.includes("Глинка")));
  // Same URL under different queries must not collapse — covered by distinct queryIds when queries differ
  const q2 = mapCheckTopToObservations({
    caseId: "case-1",
    auditRunId: "run-1",
    regionLabel: "RU",
    language: "ru",
    queries: ["Сергей Михайлович Глинка"],
    se: [{ type: 2, region: ARSENKIN_REGION.YANDEX_MOSCOW }],
    payload: {
      result: {
        result: {
          collect: [[[top[0]!.url]]],
          snippets: {},
        },
      },
    },
  });
  assert.notEqual(top[0]!.queryId, q2[0]!.queryId);

  const suggestReq = buildSuggestRequest({
    queries: ["Глинка Сергей Михайлович"],
    se: 1,
    region: ARSENKIN_REGION.YANDEX_MOSCOW,
  });
  assert.equal(suggestReq.tools_name, "suggest");
  const suggests = mapSuggestToObservations({
    caseId: "case-1",
    auditRunId: "run-1",
    regionLabel: "RU",
    language: "ru",
    queries: ["Глинка Сергей Михайлович"],
    se: 1,
    payload: load("get-suggest.json"),
  });
  assert.ok(suggests.length >= 3, `expected autocomplete rows, got ${suggests.length}`);
  assert.equal(suggests[0]?.surface, "autocomplete");
  assert.equal(suggests[0]?.engine, "YANDEX");

  const paaReq = buildPaaRequest({
    queries: ["Глинка Сергей Михайлович"],
    region: ARSENKIN_REGION.GOOGLE_MOSCOW,
    depth: 1,
    count: 10,
  });
  assert.equal(paaReq.data.se, 2);
  const paa = mapPaaToObservations({
    caseId: "case-1",
    auditRunId: "run-1",
    regionLabel: "RU",
    language: "ru",
    queries: ["Глинка Сергей Михайлович"],
    payload: load("get-paa.json"),
  });
  assert.equal(paa.length, 2);
  assert.equal(paa[0]?.surface, "paa");
  assert.equal(paa[0]?.engine, "GOOGLE");
  assert.ok(paa[0]?.parentQueryId);
  assert.ok(String(paa[0]?.rawPayloadJson?.engineNote).includes("google-only"));

  const aiReq = buildAiSerpRequest({
    queries: ["Глинка Сергей Михайлович"],
    se: 1,
    region: ARSENKIN_REGION.YANDEX_MOSCOW,
  });
  assert.equal(aiReq.tools_name, "ai-serp");
  assert.equal(aiReq.data.se, 1);
  assert.ok(Array.isArray(aiReq.data.brands) && (aiReq.data.brands as string[]).length > 0);
  assert.equal(typeof aiReq.data.host, "string");
  const ai = mapAiSerpToObservations({
    caseId: "case-1",
    auditRunId: "run-1",
    regionLabel: "RU",
    language: "ru",
    queries: ["Глинка Сергей Михайлович"],
    se: 1,
    payload: load("get-ai-serp.json"),
  });
  assert.ok(ai.length >= 2, `expected ai_answer rows, got ${ai.length}`);
  assert.equal(ai[0]?.surface, "ai_answer");
  assert.equal(ai[0]?.engine, "YANDEX");
  assert.equal(ai[0]?.domain, "ai-serp");
  assert.equal(ai[0]?.rawPayloadJson?.notKnowledgePanel, true);
  assert.match(String(ai[0]?.title), /ИИ-ответ/);

  const aiAbsent = mapAiSerpToObservations({
    caseId: "case-1",
    auditRunId: "run-1",
    regionLabel: "RU",
    language: "ru",
    queries: ["Глинка Сергей Михайлович"],
    se: 1,
    payload: load("get-ai-serp-absent.json"),
  });
  assert.equal(aiAbsent.length, 1);
  assert.equal(aiAbsent[0]?.providerStatus, "NO_RESULTS");
  assert.equal(aiAbsent[0]?.rawPayloadJson?.notKnowledgePanel, true);

  console.log(
    JSON.stringify(
      {
        ok: true,
        organic: top.length,
        autocomplete: suggests.length,
        paa: paa.length,
        aiAnswer: ai.length,
        aiAbsent: aiAbsent.length,
        sampleOrganic: top.slice(0, 2).map((d) => ({ rank: d.rank, domain: d.domain, title: d.title })),
        sampleSuggest: suggests.map((d) => d.title),
        samplePaa: paa.map((d) => d.title),
        sampleAi: ai.slice(0, 3).map((d) => ({ title: d.title, domain: d.domain })),
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
