/**
 * Offline acceptance for §0.3 — golden-case harness.
 *
 * Asserts: fixture size band, prepare succeeds, two runs match, baseline matches.
 * Run: npm run smoke:golden-case
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before } from "node:test";

import { buildGoldenCaseObservations } from "../fixtures/golden-case/build-observations";
import { main as runGoldenCaseCli } from "./run-golden-case-report";
import {
  buildExecutiveSummaryFragment,
  composeExecutivePageStructure,
  fragmentScope,
} from "../src/modules/digital-profile/orion-golden/deck-sections";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = join(ROOT, "fixtures", "golden-case", "baseline.json");

describe("golden-case fixtures", () => {
  it("builds ~300 composite observations with required surfaces", () => {
    const rows = buildGoldenCaseObservations();
    assert.ok(rows.length >= 280 && rows.length <= 340, `count=${rows.length}`);
    assert.ok(rows.some((r) => r.kind === "organic" && r.region === "RU"));
    assert.ok(rows.some((r) => r.kind === "organic" && r.region === "UAE"));
    assert.ok(rows.some((r) => r.kind === "suggestion"));
    assert.ok(rows.some((r) => r.kind === "paa"));
    assert.ok(rows.some((r) => r.surface === "images"));
    assert.ok(rows.some((r) => r.surface === "ai_answer"));
    assert.ok(rows.some((r) => r.surface === "wikipedia"));
    assert.ok(rows.some((r) => r.surface === "serp_screenshot"));
    const compliance = rows.filter((r) => /lexisnexis|dow jones|worldcompliance/i.test(r.title ?? ""));
    assert.equal(compliance.length, 2);
    assert.ok(rows.some((r) => /hockey|nhl|goaltender|хоккей|вратарь/i.test(`${r.title} ${r.snippet}`)));
  });

  it("baseline file is committed", () => {
    assert.ok(existsSync(BASELINE), "fixtures/golden-case/baseline.json must exist");
  });
});

describe("golden-case report harness", () => {
  it("is deterministic and matches baseline", async () => {
    const code = await runGoldenCaseCli([]);
    assert.equal(code, 0, "golden-case CLI must exit 0 against baseline");
  });
});

/** REMEDIATION §7.3 — sparse («мало findings») executive acceptance on golden harness. */
describe("REMEDIATION §7.3 golden sparse executive", () => {
  it("мало findings → ≥3 content blocks + structureBlocks metric", () => {
    const es = {
      verdict: "INSUFFICIENT_DATA",
      executiveConclusion:
        "Собранных подтверждённых данных по субъекту недостаточно для доказательного вывода.",
      keyFindings: [] as Array<{
        findingId: string;
        title: string;
        factualBasis: string;
        clientImpact: string;
        recommendedAction: string;
      }>,
      priorityActions: ["Расширить проверку по незакрытым направлениям."],
      identityCaveats: [
        "Материалы о другом лице исключены из выводов о проверяемом субъекте.",
        "Неоднозначные наблюдения не учитывались как факты.",
      ],
      dataLimitations: ["Выборка комплаенс-баз ограничена."],
      regionalOverview: [{ region: "RU", oneLiner: "Регион RU: мало подтверждённых материалов.", totalCount: 12 }],
    };
    const scoped = {
      subject: { displayName: "Golden Sparse", aliases: [] as string[] },
      findings: [],
      surfaceUnits: [
        { surface: "organic" as const, region: "RU", metrics: [], claims: [], evidenceRefs: [] },
        { surface: "suggestions" as const, region: "RU", metrics: [], claims: [], evidenceRefs: [] },
        { surface: "images" as const, region: "RU", metrics: [], claims: [], evidenceRefs: [] },
      ],
      metricSnapshot: {
        metricSnapshotId: "m-golden-sparse",
        datasetId: "d-golden-sparse",
        reportRunId: "r-golden-sparse",
        baseCount: 40,
        enrichmentCount: 0,
        compositeCount: 40,
        subjectMatchCount: 2,
        likelySubjectCount: 5,
        ambiguousCount: 3,
        otherSubjectCount: 8,
        adverseFindingCount: 0,
        perRegionCounts: { RU: 25, UAE: 15 },
      },
      scope: fragmentScope("EXECUTIVE_SUMMARY"),
      evidenceIndex: {},
    };
    const structure = composeExecutivePageStructure(scoped as never, es);
    const blockCount =
      structure.narrativeParagraphs.length +
      structure.factCards.length +
      (structure.recommendations ? 1 : 0);
    assert.ok(blockCount >= 3, `expected ≥3 blocks, got ${blockCount}`);

    const out = buildExecutiveSummaryFragment("EXECUTIVE" as never, scoped as never, {
      executiveSummary: es,
    });
    assert.equal(out.status, "READY");
    const slide = out.slides[0]!;
    assert.ok(String(slide.content.narrative ?? "").split(/\n+/).filter(Boolean).length >= 2);
    assert.ok((slide.content.bullets?.length ?? 0) >= 2);
    assert.ok(String(slide.content.whatToCheck ?? "").length > 20);
    assert.ok(Number(slide.metrics?.structureBlocks ?? 0) >= 3);
    assert.equal(slide.metrics?.sparse, 1);
  });
});
