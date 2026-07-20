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
  applyExecutiveFreshnessChangeToPacks,
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
    const foldedParas = folded.split("\n").filter(Boolean);
    assert.ok(foldedParas.length >= 2, "§7.2 must be its own paragraph");
    assert.match(foldedParas[1]!, /Данные собраны 01\.07\.2025/i);
    assert.match(foldedParas[1]!, /Новых материалов с прошлого отчёта: 610/);
    assert.ok(!EXEC_MARKER_IN_LEAD(foldedParas[0]!), "lead para must not bury §7.2");

    // Long lead (PDF 28 failure mode): §7.2 was clipped inside para 0 — promote out.
    const longLead =
      "Цифровой профиль субъекта характеризуется высокой публичной узнаваемостью и значительным объёмом материалов, напрямую относящихся к проверяемому лицу: 631 совпадение из 742. Ключевой репутационный фон формируют санкционные, PEP/watchlist, судебно-криминальные, политические и корпоративно-финансовые сюжеты. Данные собраны 03.07.2026; самый свежий материал — 19.07.2026.\n" +
      "Проверяемое лицо имеет крайне заметный публичный цифровой след.";
    const promoted = ensureExecutiveFreshnessChangeInNarrative(longLead, extras);
    const promotedParas = promoted.split("\n").filter(Boolean);
    assert.equal(promotedParas.length, 3);
    assert.match(promotedParas[1]!, /Данные собраны 01\.07\.2025/i);
    assert.ok(!/данные собраны|Новых материалов/i.test(promotedParas[0]!));
    assert.ok(!/данные собраны|Новых материалов/i.test(promotedParas[2]!));

    const out = buildExecutiveSummaryFragment("EXECUTIVE_SUMMARY" as never, scoped as never, extras);
    assert.equal(out.status, "READY");
    const narrative = String(out.slides[0]?.content.narrative ?? "");
    const narParas = narrative.split("\n").filter(Boolean);
    assert.ok(narParas.some((p) => /Новых материалов с прошлого отчёта: 610/i.test(p)));
    assert.ok(
      narParas.some(
        (p) =>
          /Данные собраны 01\.07\.2025/i.test(p) &&
          p.length < 320 &&
          !/цифровой профиль|критический репутационный/i.test(p)
      ),
      "§7.2 must be a short standalone paragraph for the executive dashboard"
    );
    const cont = out.slides.find((s) => s.isContinuation);
    assert.ok(cont, "continuation slide expected");
    assert.ok(
      (cont!.content.bullets ?? []).some((b) => /Новых материалов|данные собраны/i.test(b)),
      "continuation should keep §7.2 bullet"
    );
  });
});

function EXEC_MARKER_IN_LEAD(text: string): boolean {
  return /данные собраны|Новых материалов с прошлого отчёта/i.test(text);
}

describe("REMEDIATION §7.2 post-GPT executive freshness pass", () => {
  it("applyExecutiveFreshnessChangeToPacks restores short §7.2 card after GPT wipe", () => {
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
    };
    const wipedNarrative =
      "Цифровой профиль Олега Владимировича Дерипаски несёт критический репутационный риск: негативные и комплаенс-чувствительные темы представлены не единично, а устойчивыми блоками публикаций о проверяемом лице. Наиболее значимые зоны — 21 судебно-криминальная публикация с негативным содержанием, 50 материалов по PEP.";
    const packs = applyExecutiveFreshnessChangeToPacks(
      [
        {
          fragmentKey: "EXECUTIVE_SUMMARY",
          slides: [
            {
              content: { narrative: wipedNarrative, bullets: ["Риск A"] },
            },
            {
              isContinuation: true,
              content: { bullets: ["Факт без свежести"] },
            },
          ],
        },
        {
          fragmentKey: "RU_SUMMARY",
          slides: [{ content: { narrative: "Регион без изменений." } }],
        },
      ],
      extras
    );
    const exec = packs[0]!;
    const paras = String(exec.slides[0]!.content.narrative ?? "")
      .split("\n")
      .filter(Boolean);
    assert.ok(paras.length >= 2);
    assert.match(paras[1]!, /Данные собраны 01\.07\.2025/i);
    assert.match(paras[1]!, /Новых материалов с прошлого отчёта: 610/);
    assert.ok(paras[1]!.length < 320);
    assert.ok(
      (exec.slides[1]!.content.bullets ?? [])[0]?.match(/Новых материалов|данные собраны/i)
    );
    assert.equal(packs[1]!.slides[0]!.content.narrative, "Регион без изменений.");
  });
});
