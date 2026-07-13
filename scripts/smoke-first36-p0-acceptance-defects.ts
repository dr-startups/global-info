/**
 * Unit tests for First36 P0 acceptance defects from PDF v60 review.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectFirst36Acceptance } from "../src/modules/digital-profile/orion-golden/classic/first36-acceptance-gate";
import {
  enforceCompleteSentences,
  hasDanglingSentenceTail,
  observationKey,
  sanitizeClientLanguage,
} from "../src/modules/digital-profile/orion-golden/classic/client-language";
import { buildSerpPositionTablesWithQuery } from "../src/modules/digital-profile/orion-golden/classic/serp-position-tables-with-query";
import { classifyWikipediaHit } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-theme-set";
import type { FullEvidenceInventory } from "../src/modules/digital-profile/orion-golden/evidence/full-evidence-inventory";

describe("first36-p0-acceptance-defects", () => {
  it("flags shared RU/UAE KPI denominator", () => {
    const r = inspectFirst36Acceptance({
      slideCount: 36,
      slides: Array.from({ length: 36 }, (_, i) => ({ pageNumber: i + 1 })),
      themeSet: { ru: { linksTotal: 171 }, uae: { linksTotal: 171 } },
    });
    assert.ok(r.issues.some((i) => i.code === "shared-kpi-denominator"));
  });

  it("flags SERP rank repeats without query column", () => {
    const r = inspectFirst36Acceptance({
      slideCount: 36,
      slides: [
        {
          pageNumber: 9,
          template: "orion_golden_search_table",
          table: {
            headers: ["Позиция", "Домен", "Заголовок", "Статус"],
            rows: [
              ["1", "a.com", "A", "Нейтральный"],
              ["1", "b.com", "B", "Нейтральный"],
            ],
          },
        },
        ...Array.from({ length: 35 }, (_, i) => ({ pageNumber: i === 0 ? 2 : i + 2 })),
      ],
    });
    assert.ok(r.issues.some((i) => i.code === "serp-rank-without-query"));
  });

  it("builds SERP tables with query column so ranks can repeat across queries", () => {
    const inventory = {
      items: [
        {
          inventoryId: "1",
          caseId: "c",
          reportRunId: "r",
          source: "serp_observation",
          provider: "SERPER",
          region: "RU",
          query: "Глинка Сергей",
          collectedAt: new Date().toISOString(),
          evidenceType: "search_result",
          title: "One",
          sourceUrl: "https://a.com/1",
          rawMetadata: { rank: 1 },
        },
        {
          inventoryId: "2",
          caseId: "c",
          reportRunId: "r",
          source: "serp_observation",
          provider: "SERPER",
          region: "RU",
          query: "Glinka Sergei",
          collectedAt: new Date().toISOString(),
          evidenceType: "search_result",
          title: "Two",
          sourceUrl: "https://a.com/1",
          rawMetadata: { rank: 1 },
        },
      ],
    } as FullEvidenceInventory;
    const tables = buildSerpPositionTablesWithQuery(inventory, "RU");
    assert.equal(tables[0]?.headers[0], "Запрос");
    assert.equal(tables[0]?.rows.length, 2);
    assert.equal(tables[0]?.rows[0]?.[1], "1");
    assert.equal(tables[0]?.rows[1]?.[1], "1");
  });

  it("classifies noble-family Wikipedia as WRONG_SUBJECT", () => {
    const hit = classifyWikipediaHit({
      title: "Глинка (дворянский род)",
      url: "https://ru.wikipedia.org/wiki/Глинка_(дворянский_род)",
      subjectName: "Глинка Сергей Михайлович",
    });
    assert.equal(hit.status, "WRONG_SUBJECT");
  });

  it("detects dangling sentence ending with как", () => {
    const bad =
      "публикация Klerk.ru, описывающая Сергея Михайловича Глинку как";
    assert.equal(hasDanglingSentenceTail(bad), true);
    const fixed = enforceCompleteSentences(bad, "Таблица фиксирует позиции выдачи.");
    assert.equal(hasDanglingSentenceTail(fixed), false);
    assert.match(fixed, /Таблиц|позиц|выдач/i);
  });

  it("sanitizes internal client jargon", () => {
    const out = sanitizeClientLanguage("Check identity and related compliance sanctions/watchlist");
    assert.doesNotMatch(out, /\bidentity\b/i);
    assert.doesNotMatch(out, /\brelated\b/i);
    assert.doesNotMatch(out, /\bcompliance\b/i);
  });

  it("observation keys differ by query even for same URL", () => {
    const a = observationKey({
      auditRunId: "r1",
      provider: "serper",
      engine: "GOOGLE",
      region: "RU",
      language: "ru",
      surface: "organic",
      queryId: "q1",
      rank: 1,
      normalizedUrlOrHash: "example.com/x",
    });
    const b = observationKey({
      auditRunId: "r1",
      provider: "serper",
      engine: "GOOGLE",
      region: "RU",
      language: "ru",
      surface: "organic",
      queryId: "q2",
      rank: 1,
      normalizedUrlOrHash: "example.com/x",
    });
    assert.notEqual(a, b);
  });

  it("flags identical related sidebars on pages 20-22", () => {
    const blob = {
      visualAnalysis: {
        whatIsVisible: "same",
        whyItMatters: "same",
      },
      clientTakeaway: "same",
    };
    const r = inspectFirst36Acceptance({
      slideCount: 36,
      slides: [
        { pageNumber: 20, ...blob },
        { pageNumber: 21, ...blob },
        { pageNumber: 22, ...blob },
        ...Array.from({ length: 33 }, (_, i) => ({ pageNumber: i < 19 ? i + 1 : i + 4 })),
      ],
    });
    assert.ok(r.issues.some((i) => i.code === "identical-related-sidebars"));
  });
});
