/**
 * Offline acceptance for the GPT report layer:
 *  stage 1 — full-corpus case analysis (runGptCaseAnalysis, fail-safe null);
 *  stage 2 — per-slide client copy (enhanceSectionPacksWithGptCopy inside the
 *  canonical prepare), with strict sanitization, per-fragment fallback and a
 *  deterministic report when GPT is unavailable.
 *
 * All GPT calls are injected fakes — NETWORK_CALLS=0, no live OpenAI.
 * Run: npm run smoke:gpt-report-copy
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import {
  runCanonicalReportPrepare,
  type CanonicalPrepareInput,
} from "../src/modules/digital-profile/services/canonical-report-prepare";
import {
  mergeCompositeSerp,
  buildReportDataBinding,
  type CompositeObservation,
} from "../src/modules/digital-profile/services/composite-serp-merge";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import type { ClassifierSubjectProfile } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { DeckRenderAdapter } from "../src/modules/digital-profile/services/render-deck-artifacts";
import {
  runGptCaseAnalysis,
  type GptCaseAnalysis,
  type GptJsonCaller,
} from "../src/modules/digital-profile/orion-golden/gpt/gpt-case-analysis";
import {
  enhanceSectionPacksWithGptCopy,
  GPT_SLIDE_COPY_PROMPT_VERSION,
  type GptSlideCopyReport,
} from "../src/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import type { VerifiedFindingBundle } from "../src/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";
import type { MetricSnapshot } from "../src/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SectionPackV2 } from "../src/modules/digital-profile/orion-golden/deck-sections/contracts";
import { SECTION_PACK_SCHEMA_VERSION } from "../src/modules/digital-profile/orion-golden/deck-sections/contracts";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const GPT_NARRATIVE_MARKER = "Развёрнутое пояснение аналитика";

// ---------- shared fixtures (subject-agnostic, mirrors canonical smoke) ----------

function subjectProfile(): ClassifierSubjectProfile {
  return {
    displayName: "Anders Holmström",
    givenNames: ["Anders"],
    familyNames: ["Holmström", "Holmstrom"],
    patronymics: [],
    aliases: ["A. Holmström", "Anders Holmstrom"],
    transliterations: ["Anders Holmstrom"],
    contextIdentifiers: ["Nordkap Capital", "fintech", "Stockholm"],
    namesakeProfiles: [
      { label: "Anders Holmström (ice-hockey goaltender)", noiseTerms: ["hockey", "nhl", "goaltender", "хоккей"] },
    ],
    negativeIdentitySignals: { wrongPatronymics: [], wrongNames: [], unrelatedKnownPersons: [] },
  };
}

let k = 0;
function obs(partial: Partial<CompositeObservation> & Pick<CompositeObservation, "kind">): CompositeObservation {
  k += 1;
  return {
    key: `k-${k}-${partial.url ?? partial.suggestion ?? partial.question ?? partial.title ?? k}`,
    region: "RU",
    engine: "YANDEX",
    query: "Anders Holmström",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: [],
    ...partial,
  };
}

function compositeObservations(): CompositeObservation[] {
  return [
    obs({
      kind: "organic",
      url: "https://di.se/holmstrom-tax-probe",
      title: "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe in Stockholm",
      snippet: "Swedish prosecutors opened a tax fraud investigation into fintech founder Anders Holmström (Nordkap Capital).",
      riskLabel: "adverse",
    }),
    obs({
      kind: "organic",
      url: "https://svd.se/holmstrom-watchlist",
      title: "Anders Holmström flagged during sanctions screening watchlist review",
      snippet: "A compliance watchlist review referenced Anders Holmström, founder Nordkap Capital; requires analyst verification.",
    }),
    obs({
      kind: "organic",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://dn.se/holmstrom-malta",
      title: "Anders Holmström linked to Malta holding structure and offshore beneficial ownership",
      snippet: "Corporate filings connect Anders Holmström (Nordkap Capital) to a Malta holding with offshore beneficial ownership.",
    }),
    obs({
      kind: "organic",
      url: "https://forbes.com/profile/holmstrom",
      title: "Anders Holmström, CEO of Nordkap Capital AB — fintech investor profile",
      snippet: "Business profile of Anders Holmström, founder and CEO of Stockholm fintech Nordkap Capital.",
    }),
    obs({
      kind: "suggestion",
      suggestion: "Anders Holmström Nordkap Capital fraud",
      title: "Anders Holmström Nordkap Capital fraud",
    }),
    obs({
      kind: "paa",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      question: "Who is Anders Holmström of Nordkap Capital?",
      title: "Who is Anders Holmström of Nordkap Capital?",
    }),
    obs({
      kind: "organic",
      region: "UAE",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://thenationalnews.com/holmstrom-dubai",
      title: "Anders Holmström expands Nordkap Capital into Dubai real-estate investment",
      snippet: "Anders Holmström announced a Dubai real-estate vehicle under Nordkap Capital.",
    }),
    obs({
      kind: "organic",
      region: "UAE",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://gulfnews.com/holmstrom-pep",
      title: "Anders Holmström referenced in UAE PEP/RCA compliance screening",
      snippet: "A UAE compliance database returned a potential PEP/RCA reference to Anders Holmström; requires verification.",
      riskLabel: "adverse",
    }),
  ];
}

async function seededPrepareInput(
  root: string,
  gptCaller: GptJsonCaller | null | undefined
): Promise<CanonicalPrepareInput> {
  const unifiedJobId = "unified-gpt-1";
  const caseId = "case-gpt-holmstrom";
  const rows = compositeObservations();
  const manifest: BaseCollectionManifest = {
    version: "base-collection-manifest-v1",
    unifiedJobId,
    caseId,
    capturedAt: new Date().toISOString(),
    baseReportRunId: "base-gpt-1",
    searchResultIds: [],
    searchSurfaceItemIds: [],
    baseCount: rows.length,
    actualProviders: [
      { providerId: "yandex", runtime: "real", status: "completed" },
      { providerId: "serper", runtime: "real", status: "completed" },
    ],
    realCollectionSufficient: true,
  };
  const merge = await mergeCompositeSerp({ manifest, fixtureBaseRows: rows });
  const binding = buildReportDataBinding({
    caseId,
    unifiedJobId,
    baseReportRunId: manifest.baseReportRunId,
    enrichmentRunIds: [],
    compositeDatasetId: merge.compositeDatasetId,
    providerCounts: merge.providerCounts,
  });
  const fakeRender: DeckRenderAdapter = async (r) => ({
    pdf: undefined,
    pptx: undefined,
    pngDir: undefined,
    pageCount: r.deckManifest.pageCount,
    renderer: "fake",
  });
  return {
    caseId,
    unifiedJobId,
    artifactsDir: root,
    binding,
    merge,
    subjectProfile: subjectProfile(),
    render: fakeRender,
    ...(gptCaller === undefined ? {} : { gptCaller }),
  };
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function validCaseAnalysisJson(): unknown {
  return {
    overallRiskLevel: "высокий",
    executiveConclusion:
      "По итогам анализа всех собранных материалов цифровой профиль субъекта содержит существенные репутационные риски: в поисковой выдаче доминируют упоминания налогового расследования и офшорной структуры.",
    digitalPortrait:
      "Для стороннего наблюдателя субъект выглядит как предприниматель, чья репутация омрачена расследованием.",
    keyRisks: [
      {
        theme: "Налоговое расследование",
        severity: "высокий",
        explanation:
          "Публикации о налоговом расследовании видны на первой странице выдачи и будут замечены банками и контрагентами при проверке, что осложняет открытие счетов и заключение сделок.",
        advice:
          "Подготовить официальную позицию и подтверждающие документы; работать над вытеснением негатива позитивными публикациями.",
      },
      {
        theme: "Служебная запись reportRunId в тексте",
        severity: "низкий",
        explanation: "Содержит внутренний токен reportRunId и должна быть отброшена.",
        advice: "Не должно попасть в отчёт.",
      },
    ],
    positiveSignals: ["Деловой профиль в авторитетном издании подтверждает статус основателя компании."],
    recommendations: [
      "Сформировать пул позитивных публикаций в авторитетных источниках.",
      "Провести повторную проверку через три месяца.",
    ],
  };
}

/** Fake GPT: stage 1 returns the case analysis; stage 2 rewrites every slide. */
function makeHappyCaller(): GptJsonCaller {
  return async ({ systemPrompt, userPayload }) => {
    if (systemPrompt.includes("ПОЛНЫЙ верифицированный аналитический корпус")) {
      return validCaseAnalysisJson();
    }
    const payload = userPayload as {
      slides: Array<{ slideId: string; title: string }>;
      caseAnalysis: { overallRiskLevel: string } | null;
    };
    // The per-fragment prompt must carry the holistic case analysis.
    assert.ok(payload.caseAnalysis, "fragment prompt must include stage-1 case analysis");
    return {
      slides: payload.slides.map((s) => ({
        slideId: s.slideId,
        narrative: `${GPT_NARRATIVE_MARKER}: сигналы на странице «${s.title}» рискованны, потому что видны банкам и контрагентам при проверке и влияют на решения о сотрудничестве. Рекомендуем подготовить официальную позицию и план вытеснения негатива.`,
        whyItMatters:
          "Эти материалы формируют первое впечатление о субъекте при любой проверке.",
        whatToCheck: "Подтвердить первоисточник и подготовить официальный комментарий.",
      })),
    };
  };
}

function readGptReport(root: string): GptSlideCopyReport {
  return JSON.parse(readFileSync(join(root, "deck", "gpt-report-copy.json"), "utf8"));
}

function readDeckBlob(root: string): string {
  return readFileSync(join(root, "deck", "assembled-deck.json"), "utf8");
}

// ---------- stage 1 unit tests ----------

const MINI_BUNDLE: VerifiedFindingBundle = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  generatedAt: new Date().toISOString(),
  sourceHashes: [],
  kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
  findings: [],
  excludedFindingIds: [],
  exclusionReasons: {},
} as unknown as VerifiedFindingBundle;

const MINI_METRICS: MetricSnapshot = {
  metricSnapshotId: "m1",
  datasetId: "d1",
  reportRunId: "r1",
  baseCount: 4,
  enrichmentCount: 0,
  compositeCount: 4,
  subjectMatchCount: 3,
  likelySubjectCount: 0,
  ambiguousCount: 1,
  otherSubjectCount: 0,
  adverseFindingCount: 1,
  perRegionCounts: { RU: 4 },
};

describe("stage 1 — full-corpus GPT case analysis", () => {
  it("returns a sanitized analysis and drops unsafe entries", async () => {
    const analysis = await runGptCaseAnalysis({
      caller: async () => validCaseAnalysisJson(),
      subjectName: "Anders Holmström",
      bundle: MINI_BUNDLE,
      surfaceUnits: [],
      metricSnapshot: MINI_METRICS,
    });
    assert.ok(analysis);
    assert.equal(analysis!.overallRiskLevel, "высокий");
    assert.ok(analysis!.executiveConclusion.includes("репутационные риски"));
    // The keyRisk carrying an internal token is dropped; the clean one stays.
    assert.equal(analysis!.keyRisks.length, 1);
    assert.equal(analysis!.keyRisks[0]!.theme, "Налоговое расследование");
    assert.equal(analysis!.recommendations.length, 2);
  });

  it("clamps over-budget stage-1 fields instead of failing schema", async () => {
    const longPortrait = `${"Портрет субъекта в выдаче выглядит негативно. ".repeat(40)}Конец.`;
    const longExpl = `${"Объяснение риска для банковских и партнёрских проверок. ".repeat(20)}Конец.`;
    const longAdvice = `${"Рекомендуем подготовить официальную позицию. ".repeat(15)}Конец.`;
    assert.ok(longPortrait.length > 1000);
    assert.ok(longExpl.length > 700);
    assert.ok(longAdvice.length > 400);

    const analysis = await runGptCaseAnalysis({
      caller: async () => ({
        overallRiskLevel: "высокий",
        executiveConclusion:
          "По итогам анализа цифровой профиль содержит существенные репутационные риски, видимые при первичной проверке.",
        digitalPortrait: longPortrait,
        keyRisks: [
          {
            theme: "Налоговое расследование",
            severity: "высокий",
            explanation: longExpl,
            advice: longAdvice,
          },
        ],
        positiveSignals: ["Деловой профиль подтверждает статус основателя."],
        recommendations: ["Сформировать пул позитивных публикаций."],
      }),
      subjectName: "Anders Holmström",
      bundle: MINI_BUNDLE,
      surfaceUnits: [],
      metricSnapshot: MINI_METRICS,
    });
    assert.ok(analysis, "over-length fields must be clamped, not discard the analysis");
    assert.ok((analysis!.digitalPortrait ?? "").length <= 1000);
    assert.ok(analysis!.keyRisks[0]!.explanation.length <= 700);
    assert.ok(analysis!.keyRisks[0]!.advice.length <= 400);
  });

  it("fails safe to null on transport error, bad schema and unsafe conclusion", async () => {
    const boom = await runGptCaseAnalysis({
      caller: async () => {
        throw new Error("openai-http-500");
      },
      subjectName: "X",
      bundle: MINI_BUNDLE,
      surfaceUnits: [],
      metricSnapshot: MINI_METRICS,
    });
    assert.equal(boom, null);

    const badSchema = await runGptCaseAnalysis({
      caller: async () => ({ totallyWrong: true }),
      subjectName: "X",
      bundle: MINI_BUNDLE,
      surfaceUnits: [],
      metricSnapshot: MINI_METRICS,
    });
    assert.equal(badSchema, null);

    const unsafe = await runGptCaseAnalysis({
      caller: async () => ({
        ...(validCaseAnalysisJson() as Record<string, unknown>),
        executiveConclusion: "Вывод содержит внутренний datasetId и не должен пройти.",
      }),
      subjectName: "X",
      bundle: MINI_BUNDLE,
      surfaceUnits: [],
      metricSnapshot: MINI_METRICS,
    });
    assert.equal(unsafe, null);
  });
});

describe("stage 2 — cache invalidation when case analysis appears", () => {
  it("does not SKIPPED_CACHED packs that were written without case analysis", async () => {
    const pack = {
      schemaVersion: SECTION_PACK_SCHEMA_VERSION,
      sectionId: "EXECUTIVE",
      sectionType: "EXECUTIVE",
      fragmentKey: "EXECUTIVE_SUMMARY",
      caseId: "c1",
      datasetId: "d1",
      reportRunId: "r1",
      sourceDatasetId: "d1",
      contentVersion: "deck-sections-v14",
      promptVersion: "executive-summary-v1",
      contentHash: "sha256:x",
      inputHash: "h1",
      generatedAt: "2026-01-01T00:00:00.000Z",
      required: true,
      status: "READY",
      sourceFindingIds: [],
      evidenceRefs: [],
      inputs: { findingIds: [], evidenceRefs: [], metricSnapshotId: "m1" },
      slides: [
        {
          schemaVersion: "slide-content-v1",
          slideId: "p03_executive",
          baseSlotId: "p03_executive",
          sectionId: "EXECUTIVE",
          fragmentKey: "EXECUTIVE_SUMMARY",
          templateId: "executive-summary",
          title: "Резюме",
          findingIds: [],
          evidenceRefs: [],
          content: { narrative: "Черновик резюме." },
        },
      ],
      metrics: {
        datasetCount: 0,
        displayedCount: 0,
        adverseDatasetCount: 0,
        adverseDisplayedCount: 0,
      },
      provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: [] },
      validation: { passed: true, issues: [] },
      // Legacy cache marker: GPT ran while stage 1 was null.
      gptCopy: { promptVersion: GPT_SLIDE_COPY_PROMPT_VERSION, appliedSlides: 1 },
    } as unknown as SectionPackV2;

    let calls = 0;
    const analysis = (await runGptCaseAnalysis({
      caller: async () => validCaseAnalysisJson(),
      subjectName: "Anders Holmström",
      bundle: MINI_BUNDLE,
      surfaceUnits: [],
      metricSnapshot: MINI_METRICS,
    }))!;

    const out = await enhanceSectionPacksWithGptCopy({
      packs: [pack],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async () => {
        calls += 1;
        return {
          slides: [
            {
              slideId: "p03_executive",
              narrative: `${GPT_NARRATIVE_MARKER}: обновлённый текст с анализом кейса для банков и контрагентов.`,
            },
          ],
        };
      },
      caseAnalysis: analysis,
      bundle: MINI_BUNDLE,
      evidenceIndex: {},
      validatePack: () => ({ passed: true, issues: [] }),
    });

    assert.equal(calls, 1, "must re-call GPT when cached copy lacked caseAnalysisUsed");
    assert.equal(out.report.fragments[0]?.status, "APPLIED");
    assert.equal(out.packs[0]?.gptCopy?.caseAnalysisUsed, true);
  });
});

// ---------- stage 2 e2e through the canonical prepare ----------

describe("stage 2 — GPT client copy inside the canonical prepare", () => {
  it("applies GPT text to analytical slides; artifacts and lineage intact", async () => {
    const root = tmp("gpt-copy-happy-");
    const input = await seededPrepareInput(root, makeHappyCaller());
    const res = await runCanonicalReportPrepare(input);
    assert.equal(res.ok, true);
    assert.equal(res.assemblyCount, 1);
    assert.equal(res.baseSlotCoverage, 36);

    // Stage-1 artifact persisted.
    const analysisPath = join(root, "analytics", "gpt-case-analysis.json");
    assert.ok(existsSync(analysisPath), "gpt-case-analysis.json must be written");
    const analysis = JSON.parse(readFileSync(analysisPath, "utf8")) as GptCaseAnalysis;
    assert.equal(analysis.overallRiskLevel, "высокий");

    // Stage-2 report persisted; analytical fragments applied, deterministic skipped.
    const report = readGptReport(root);
    const byKey = new Map(report.fragments.map((f) => [f.fragmentKey, f]));
    assert.equal(report.caseAnalysisUsed, true);
    assert.equal(byKey.get("FRONT_MATTER_MAIN")?.status, "SKIPPED_DETERMINISTIC");
    assert.equal(byKey.get("RISK_MATRIX")?.status, "SKIPPED_DETERMINISTIC");
    const applied = report.fragments.filter((f) => f.status === "APPLIED");
    assert.ok(applied.length >= 3, `applied=${applied.map((f) => f.fragmentKey).join(",")}`);
    assert.ok(applied.some((f) => f.fragmentKey === "EXECUTIVE_SUMMARY"));

    // GPT text reached the assembled client deck.
    const blob = readDeckBlob(root);
    assert.ok(blob.includes(GPT_NARRATIVE_MARKER), "GPT narrative must reach assembled deck");
    assert.ok(blob.includes("Рекомендуем подготовить официальную позицию"));
  });

  it("rejects unsafe GPT fields individually (internal tokens, foreign domains)", async () => {
    const root = tmp("gpt-copy-unsafe-");
    const dirtyCaller: GptJsonCaller = async ({ systemPrompt, userPayload }) => {
      if (systemPrompt.includes("ПОЛНЫЙ верифицированный аналитический корпус")) {
        return validCaseAnalysisJson();
      }
      const payload = userPayload as { slides: Array<{ slideId: string; title: string }> };
      return {
        slides: payload.slides.map((s) => ({
          slideId: s.slideId,
          // Unsafe: internal token — must be rejected.
          narrative: `Черновой pipeline reportRunId для «${s.title}».`,
          // Unsafe: domain the slide's evidence does not carry.
          whatWasFound: "Обнаружены публикации на злоумышленном ресурсе evil-attacker.example.",
          // Safe: must be applied.
          whatToCheck: "Проверить первоисточники и подготовить комментарий.",
        })),
      };
    };
    const input = await seededPrepareInput(root, dirtyCaller);
    const res = await runCanonicalReportPrepare(input);
    assert.equal(res.ok, true);

    const report = readGptReport(root);
    const rejected = report.fragments.flatMap((f) => f.rejectedFields);
    assert.ok(rejected.some((r) => r.includes("internal-token")), rejected.join(" | "));
    assert.ok(rejected.some((r) => r.includes("foreign-domain")), rejected.join(" | "));

    const blob = readDeckBlob(root);
    assert.ok(!blob.includes("evil-attacker.example"), "foreign domain must never reach the deck");
    assert.ok(!/Черновой pipeline reportRunId/.test(blob), "internal token text must never reach the deck");
    assert.ok(blob.includes("Проверить первоисточники и подготовить комментарий."));
  });

  it("falls back to the deterministic report when GPT errors mid-flight", async () => {
    const root = tmp("gpt-copy-error-");
    const failingCaller: GptJsonCaller = async () => {
      throw new Error("openai-http-503");
    };
    const input = await seededPrepareInput(root, failingCaller);
    const res = await runCanonicalReportPrepare(input);
    assert.equal(res.ok, true, "GPT failure must never block the report");
    assert.equal(res.baseSlotCoverage, 36);

    // Stage 1 failed → no case-analysis artifact; stage 2 all fallbacks.
    assert.ok(!existsSync(join(root, "analytics", "gpt-case-analysis.json")));
    const report = readGptReport(root);
    assert.equal(report.caseAnalysisUsed, false);
    const llmFragments = report.fragments.filter(
      (f) => !["SKIPPED_DETERMINISTIC", "SKIPPED_EMPTY"].includes(f.status)
    );
    assert.ok(llmFragments.length > 0);
    assert.ok(llmFragments.every((f) => f.status === "FALLBACK_ERROR"));
    assert.ok(!readDeckBlob(root).includes(GPT_NARRATIVE_MARKER));
  });

  it("NETWORK_CALLS=0 without an injected caller → fully deterministic, no GPT artifacts", async () => {
    const root = tmp("gpt-copy-off-");
    const input = await seededPrepareInput(root, undefined);
    const res = await runCanonicalReportPrepare(input);
    assert.equal(res.ok, true);
    assert.ok(!existsSync(join(root, "deck", "gpt-report-copy.json")));
    assert.ok(!existsSync(join(root, "analytics", "gpt-case-analysis.json")));
  });

  it("no internal or forbidden tokens anywhere in the GPT-enhanced artifacts", async () => {
    const root = tmp("gpt-copy-clean-");
    const input = await seededPrepareInput(root, makeHappyCaller());
    await runCanonicalReportPrepare(input);
    const deckDir = join(root, "deck");
    let blob = "";
    for (const e of readdirSync(deckDir, { withFileTypes: true, recursive: true })) {
      if (e.isFile() && e.name === "assembled-deck.json") {
        blob += readFileSync(join(e.parentPath ?? deckDir, e.name), "utf8");
      }
    }
    // Client-facing deck must stay free of internal identifiers.
    const parsed = JSON.parse(readDeckBlob(root)) as {
      slides: Array<{ narrative?: string; bullets?: string[] }>;
    };
    for (const s of parsed.slides) {
      const texts = [s.narrative ?? "", ...(s.bullets ?? [])].join(" ");
      assert.ok(!/reportRunId|datasetId|inventoryId/iu.test(texts), texts.slice(0, 120));
    }
    void blob;
  });
});
