/**
 * REMEDIATION §7.2 — material dates into inventory + prior-report diff.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-report-material-freshness.ts
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { compositeObservationsToInventory } from "../src/modules/digital-profile/services/canonical-report-prepare";
import {
  mergeCompositeSerp,
  type CompositeObservation,
} from "../src/modules/digital-profile/services/composite-serp-merge";
import {
  buildReportDiffArtifact,
  computeMaterialFreshness,
  diffMaterialKeys,
  formatRuDate,
  freshnessFootnote,
  preferNewerCollectedAt,
  reportDiffClientLine,
} from "../src/modules/digital-profile/services/report-material-freshness";
import {
  buildExecutiveSummaryFragment,
  buildRegionalSummaryFragment,
  composeExecutivePageStructure,
  ensureExecutiveFreshnessChangeInNarrative,
} from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";

describe("REMEDIATION §7.2 material freshness and report-diff", () => {
  it("preferNewerCollectedAt keeps the later ISO", () => {
    assert.equal(
      preferNewerCollectedAt("2024-01-01T00:00:00.000Z", "2025-06-15T12:00:00.000Z"),
      "2025-06-15T12:00:00.000Z"
    );
    assert.equal(preferNewerCollectedAt(undefined, "2025-01-01T00:00:00.000Z"), "2025-01-01T00:00:00.000Z");
    assert.equal(preferNewerCollectedAt("1970-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"), "2025-01-01T00:00:00.000Z");
  });

  it("formatRuDate / freshnessFootnote use calendar dates", () => {
    assert.equal(formatRuDate("2025-07-10T10:00:00.000Z"), "10.07.2025");
    const f = computeMaterialFreshness([
      "2025-07-01T00:00:00.000Z",
      "2025-07-18T00:00:00.000Z",
      "1970-01-01T00:00:00.000Z",
    ]);
    assert.ok(f);
    assert.match(String(freshnessFootnote(f!)), /данные собраны 01\.07\.2025; самый свежий материал — 18\.07\.2025/);
  });

  it("dates reach inventory from composite observations", async () => {
    const collectedAt = "2025-07-12T08:30:00.000Z";
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "unified-fresh-1",
      caseId: "case-fresh",
      capturedAt: new Date().toISOString(),
      baseReportRunId: "run-fresh",
      baseCount: 1,
      searchResultIds: [],
      searchSurfaceItemIds: [],
      actualProviders: [],
      realCollectionSufficient: true,
    };
    const row: CompositeObservation = {
      key: "organic|ru|yandex|q|https://example.com/a",
      kind: "organic",
      region: "RU",
      engine: "YANDEX",
      query: "q",
      url: "https://example.com/a",
      title: "Title A",
      providers: ["yandex"],
      primaryProvider: "yandex",
      evidenceRefs: ["searchResult:sr1"],
      collectedAt,
    };
    const merge = await mergeCompositeSerp({
      manifest,
      fixtureBaseRows: [row],
    });
    assert.equal(merge.observations[0]?.collectedAt, collectedAt);

    const items = compositeObservationsToInventory({
      caseId: "case-fresh",
      baseReportRunId: "run-fresh",
      enrichmentRunId: null,
      observations: merge.observations,
    });
    assert.equal(items[0]?.collectedAt, collectedAt);
    assert.notEqual(items[0]?.collectedAt, new Date(0).toISOString());
  });

  it("dedupe prefers newer collectedAt", async () => {
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "unified-fresh-2",
      caseId: "case-fresh",
      capturedAt: new Date().toISOString(),
      baseReportRunId: "run-fresh",
      baseCount: 2,
      searchResultIds: [],
      searchSurfaceItemIds: [],
      actualProviders: [],
      realCollectionSufficient: true,
    };
    const key = "organic|ru|yandex|q|https://example.com/dup";
    const merge = await mergeCompositeSerp({
      manifest,
      fixtureBaseRows: [
        {
          key,
          kind: "organic",
          region: "RU",
          engine: "YANDEX",
          query: "q",
          url: "https://example.com/dup",
          title: "Old",
          providers: ["yandex"],
          primaryProvider: "yandex",
          evidenceRefs: ["searchResult:a"],
          collectedAt: "2025-01-01T00:00:00.000Z",
        },
        {
          key,
          kind: "organic",
          region: "RU",
          engine: "YANDEX",
          query: "q",
          url: "https://example.com/dup",
          title: "New",
          providers: ["yandex"],
          primaryProvider: "yandex",
          evidenceRefs: ["searchResult:b"],
          collectedAt: "2025-06-01T00:00:00.000Z",
        },
      ],
    });
    assert.equal(merge.observations.length, 1);
    assert.equal(merge.observations[0]?.collectedAt, "2025-06-01T00:00:00.000Z");
  });

  it("report-diff vs previous job dir yields added/removed counts", () => {
    const root = mkdtempSync(join(tmpdir(), "report-diff-"));
    const prevId = "unified-prev-1";
    const curId = "unified-cur-1";
    const prevDir = join(root, prevId);
    const curDir = join(root, curId);
    mkdirSync(prevDir, { recursive: true });
    mkdirSync(curDir, { recursive: true });
    writeFileSync(
      join(prevDir, "composite-serp-observations.json"),
      JSON.stringify({
        observations: [{ key: "k-a" }, { key: "k-b" }, { key: "k-gone" }],
      }),
      "utf8"
    );
    writeFileSync(join(prevDir, "canonical-prepare-summary.json"), "{}\n", "utf8");
    writeFileSync(
      join(curDir, "composite-serp-observations.json"),
      JSON.stringify({
        observations: [{ key: "k-a" }, { key: "k-b" }, { key: "k-new" }],
      }),
      "utf8"
    );

    const { added, removed } = diffMaterialKeys(["k-a", "k-b", "k-new"], ["k-a", "k-b", "k-gone"]);
    assert.deepEqual(added, ["k-new"]);
    assert.deepEqual(removed, ["k-gone"]);

    const artifact = buildReportDiffArtifact({
      caseId: "case-diff",
      currentJobId: curId,
      currentKeys: ["k-a", "k-b", "k-new"],
      caseRootDir: root,
    });
    assert.equal(artifact.status, "OK");
    assert.equal(artifact.previousJobId, prevId);
    assert.equal(artifact.addedCount, 1);
    assert.equal(artifact.removedCount, 1);
    assert.match(String(reportDiffClientLine(artifact)), /Новых материалов с прошлого отчёта: 1, ушло из выдачи: 1/);
  });

  it("executive + regional copy include freshness and change line", () => {
    const extras = {
      materialFreshness: {
        earliestAt: "2025-07-01T00:00:00.000Z",
        latestAt: "2025-07-18T00:00:00.000Z",
      },
      reportDiff: {
        addedCount: 2,
        removedCount: 1,
        previousJobId: "unified-prev",
      },
      executiveSummary: {
        verdict: "INSUFFICIENT_DATA",
        executiveConclusion: "Подтверждённых adverse-находок недостаточно для риск-выводов.",
        keyFindings: [],
        priorityActions: ["Расширить проверку по незакрытым направлениям."],
        identityCaveats: [],
        dataLimitations: [],
        regionalOverview: [],
      },
    };
    const scoped = {
      subject: { displayName: "Test Subject", aliases: [] },
      findings: [],
      surfaceUnits: [],
      metricSnapshot: {
        metricSnapshotId: "m1",
        datasetId: "d1",
        reportRunId: "r1",
        baseCount: 10,
        enrichmentCount: 0,
        compositeCount: 10,
        subjectMatchCount: 2,
        likelySubjectCount: 1,
        ambiguousCount: 0,
        otherSubjectCount: 0,
        adverseFindingCount: 0,
        perRegionCounts: { RU: 10 },
      },
      scope: { regions: null, surfaces: null, subjectMatch: null, findingIds: null },
      evidenceIndex: {
        "inventory:1": { domain: "example.com", title: "A" },
      },
    };

    const structure = composeExecutivePageStructure(scoped as never, extras.executiveSummary, {
      extras,
    });
    const coverage = structure.narrativeParagraphs.join(" ");
    assert.match(coverage, /данные собраны 01\.07\.2025/i);
    assert.match(coverage, /самый свежий материал — 18\.07\.2025/i);
    assert.match(coverage, /Новых материалов с прошлого отчёта: 2/);

    const regional = buildRegionalSummaryFragment(
      "RU_SUMMARY",
      "RU_SUMMARY" as never,
      "Россия",
      scoped as never,
      extras
    );
    const text = JSON.stringify(regional.slides);
    assert.match(text, /данные собраны 01\.07\.2025/i);
    assert.match(text, /Новых материалов с прошлого отчёта: 2, ушло из выдачи: 1/);
  });

  it("dense executive narrative folds §7.2 even when GPT omits coverage", () => {
    const extras = {
      materialFreshness: {
        earliestAt: "2025-07-01T00:00:00.000Z",
        latestAt: "2025-07-18T00:00:00.000Z",
      },
      reportDiff: {
        addedCount: 610,
        removedCount: 46,
        previousJobId: "unified-prev",
      },
      executiveSummary: {
        verdict: "HIGH_RISK",
        executiveConclusion:
          "Итоговая оценка — критический репутационный риск. В проверенном массиве значительная часть материалов прямо относится к проверяемому лицу: 631 из 742.",
        keyFindings: [
          {
            findingId: "f1",
            title: "Санкции",
            factualBasis: "Подтверждённый факт: 10 публикаций.",
            clientImpact: "Банковский риск.",
            recommendedAction: "Проверить статус.",
          },
        ],
        priorityActions: ["Собрать пакет для банков."],
        identityCaveats: [],
        dataLimitations: [],
        regionalOverview: [],
      },
      gptCaseAnalysis: {
        executiveConclusion:
          "Итоговая оценка по субъекту — критический репутационный риск. В проверенном массиве значительная часть материалов прямо относится к проверяемому лицу: 631 из 742.",
        digitalPortrait: "Публичный деловой профиль с устойчивым негативным фоном.",
        keyRisks: [],
        recommendations: ["Подготовить единый пакет для банков."],
        positiveSignals: [],
      },
    };
    const scoped = {
      subject: { displayName: "Test Subject", aliases: [] },
      findings: [],
      surfaceUnits: [],
      metricSnapshot: {
        metricSnapshotId: "m1",
        datasetId: "d1",
        reportRunId: "r1",
        baseCount: 742,
        enrichmentCount: 0,
        compositeCount: 742,
        subjectMatchCount: 631,
        likelySubjectCount: 30,
        ambiguousCount: 0,
        otherSubjectCount: 0,
        adverseFindingCount: 6,
        perRegionCounts: { RU: 500, UAE: 242 },
      },
      scope: { regions: null, surfaces: null, subjectMatch: null, findingIds: null },
      evidenceIndex: {},
    };

    const folded = ensureExecutiveFreshnessChangeInNarrative(
      extras.gptCaseAnalysis.executiveConclusion,
      extras
    );
    assert.match(folded, /Данные собраны 01\.07\.2025/i);
    assert.match(folded, /Новых материалов с прошлого отчёта: 610/);

    const out = buildExecutiveSummaryFragment("EXECUTIVE_SUMMARY" as never, scoped as never, extras);
    assert.equal(out.status, "READY");
    const narrative = String(out.slides[0]?.content.narrative ?? "");
    assert.match(narrative, /Данные собраны 01\.07\.2025|данные собраны 01\.07\.2025/i);
    assert.match(narrative, /Новых материалов с прошлого отчёта: 610/);
    const cont = out.slides.find((s) => s.isContinuation);
    assert.ok(cont, "continuation slide expected");
    assert.ok(
      (cont!.content.bullets ?? []).some((b) => /Новых материалов|данные собраны/i.test(b)),
      "continuation should keep §7.2 bullet"
    );
  });
});
