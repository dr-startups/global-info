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
import { after, before, describe, it } from "node:test";

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
  GPT_STAGE1_MAP_PROMPT_MARKER,
  GPT_STAGE1_REDUCE_PROMPT_MARKER,
  splitCorpusIntoMapBatches,
} from "../src/modules/digital-profile/orion-golden/gpt/gpt-case-analysis-mapreduce";
import type { SurfaceAnalysisUnit } from "../src/modules/digital-profile/orion-golden/contracts/surface-analysis";
import type { Finding } from "../src/modules/digital-profile/orion-golden/contracts/finding";
import {
  enhanceSectionPacksWithGptCopy,
  GPT_SLIDE_COPY_DENSITY_MARKER,
  GPT_SLIDE_COPY_FIELD_BUDGETS,
  GPT_SLIDE_COPY_PROMPT_VERSION,
  isHonestEmptyStateSlide,
  measureSlideCopyDensity,
  type GptSlideCopyReport,
} from "../src/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import { buildSerpFragment } from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders";
import { fragmentScope } from "../src/modules/digital-profile/orion-golden/deck-sections";
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
    if (
      systemPrompt.includes("ПОЛНЫЙ верифицированный аналитический корпус") ||
      systemPrompt.includes(GPT_STAGE1_REDUCE_PROMPT_MARKER)
    ) {
      return validCaseAnalysisJson();
    }
    if (systemPrompt.includes(GPT_STAGE1_MAP_PROMPT_MARKER)) {
      return miniMapJson();
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
        whatWasFound:
          "На странице зафиксированы материалы по темам повышенного внимания из scoped findings; детали опираются на переданные источники.",
        whyItMatters:
          "Эти материалы формируют первое впечатление о субъекте при любой проверке и могут влиять на банковские и партнёрские решения.",
        whatToCheck: "Подтвердить первоисточник и подготовить официальный комментарий.",
        bullets: [
          `По странице «${s.title}»: требуется проверка первоисточников и единая позиция по негативным сигналам.`,
        ],
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

function miniMapJson(): unknown {
  return {
    keyRisks: [
      {
        theme: "Налоговое расследование",
        severity: "высокий",
        explanation:
          "Публикации о расследовании видны при банковской проверке и осложняют сделки.",
        advice: "Подготовить официальную позицию и подтверждающие документы.",
      },
    ],
    notableFacts: ["В выдаче присутствуют материалы о налоговой проверке."],
    positiveSignals: ["Есть деловой профиль в авторитетном издании."],
  };
}

function largeCorpusFixture(): {
  bundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
} {
  const baseFinding = {
    schemaVersion: "finding-v2" as const,
    caseId: "c1",
    datasetId: "d1",
    sourceHashes: [] as string[],
    providers: ["yandex"],
    contradictions: [] as Finding["contradictions"],
    limitations: [] as string[],
    promotionPriority: "P2" as const,
  };
  const findings: Finding[] = [
    {
      ...baseFinding,
      findingId: "f-ru-1",
      theme: "Налоговое расследование",
      claim: "В RU-выдаче есть материалы о налоговом расследовании субъекта.",
      subjectMatch: "SUBJECT_MATCH",
      riskLevel: "high",
      confidence: 0.8,
      regions: ["RU"],
      surfaceKinds: ["organic"],
      sourceDomains: ["di.se"],
      recommendedAction: "Проверить первоисточник.",
      evidenceRefs: ["e1"],
    },
    {
      ...baseFinding,
      findingId: "f-uae-1",
      theme: "PEP/RCA упоминание",
      claim: "В UAE-выдаче есть потенциальная PEP/RCA ссылка на субъекта.",
      subjectMatch: "SUBJECT_MATCH",
      riskLevel: "medium",
      confidence: 0.7,
      regions: ["UAE"],
      surfaceKinds: ["organic"],
      sourceDomains: ["gulfnews.com"],
      recommendedAction: "Уточнить статус записи.",
      evidenceRefs: ["e2"],
    },
    {
      ...baseFinding,
      findingId: "f-sug-1",
      theme: "Негативные подсказки",
      claim: "Подсказки связывают субъекта с fraud.",
      subjectMatch: "SUBJECT_MATCH",
      riskLevel: "medium",
      confidence: 0.6,
      regions: ["RU"],
      surfaceKinds: ["suggestions"],
      sourceDomains: ["yandex.ru"],
      recommendedAction: "Зафиксировать формулировки подсказок.",
      evidenceRefs: ["e3"],
    },
    {
      ...baseFinding,
      findingId: "f-ai-1",
      theme: "AI-карточка",
      claim: "AI-ответ кратко описывает субъекта как основателя компании.",
      subjectMatch: "SUBJECT_MATCH",
      riskLevel: "low",
      confidence: 0.5,
      regions: ["RU"],
      surfaceKinds: ["ai_answers"],
      sourceDomains: ["yandex.ru"],
      recommendedAction: "Сверить с первоисточниками.",
      evidenceRefs: ["e4"],
    },
    {
      ...baseFinding,
      findingId: "f-comp-1",
      theme: "Комплаенс-хит",
      claim: "В комплаенс-базе есть запись, требующая проверки.",
      subjectMatch: "SUBJECT_MATCH",
      riskLevel: "high",
      confidence: 0.7,
      regions: ["RU"],
      surfaceKinds: ["compliance"],
      sourceDomains: ["internal"],
      recommendedAction: "Провести ручную сверку.",
      evidenceRefs: ["e5"],
    },
  ];

  const surfaceUnits: SurfaceAnalysisUnit[] = [
    {
      surface: "organic",
      region: "RU",
      engine: "YANDEX",
      metrics: [{ key: "organic_count", value: 12, sampleStatus: "MEASURED" }],
      claims: [
        {
          claimId: "c1",
          text: "Материал о налоговом расследовании",
          subjectMatch: "SUBJECT_MATCH",
          evidenceRefs: ["e1"],
          riskHint: "high",
        },
      ],
      evidenceRefs: ["e1"],
    },
    {
      surface: "organic",
      region: "UAE",
      engine: "GOOGLE",
      metrics: [{ key: "organic_count", value: 4, sampleStatus: "MEASURED" }],
      claims: [
        {
          claimId: "c2",
          text: "Упоминание в UAE-выдаче",
          subjectMatch: "SUBJECT_MATCH",
          evidenceRefs: ["e2"],
        },
      ],
      evidenceRefs: ["e2"],
    },
    {
      surface: "suggestions",
      region: "RU",
      engine: "YANDEX",
      metrics: [{ key: "suggestion_count", value: 6, sampleStatus: "MEASURED" }],
      claims: [
        {
          claimId: "c3",
          text: "Подсказка с fraud",
          subjectMatch: "SUBJECT_MATCH",
          evidenceRefs: ["e3"],
        },
      ],
      evidenceRefs: ["e3"],
    },
    {
      surface: "ai_answers",
      region: "RU",
      engine: "YANDEX",
      metrics: [{ key: "ai_count", value: 1, sampleStatus: "MEASURED" }],
      claims: [
        {
          claimId: "c4",
          text: "AI-карточка о субъекте",
          subjectMatch: "SUBJECT_MATCH",
          evidenceRefs: ["e4"],
        },
      ],
      evidenceRefs: ["e4"],
    },
    {
      surface: "compliance",
      region: "RU",
      engine: "INTERNAL",
      metrics: [{ key: "compliance_hits", value: 1, sampleStatus: "MEASURED" }],
      claims: [
        {
          claimId: "c5",
          text: "Комплаенс-запись",
          subjectMatch: "SUBJECT_MATCH",
          evidenceRefs: ["e5"],
          riskHint: "high",
        },
      ],
      evidenceRefs: ["e5"],
    },
  ];

  const bundle = {
    ...MINI_BUNDLE,
    findings,
  } as VerifiedFindingBundle;

  return {
    bundle,
    surfaceUnits,
    metricSnapshot: {
      ...MINI_METRICS,
      compositeCount: 40,
      subjectMatchCount: 30,
      adverseFindingCount: 3,
      perRegionCounts: { RU: 30, UAE: 10 },
    },
  };
}

describe("stage 1 — map-reduce (§4.4)", () => {
  after(() => {
    process.env.ORION_GPT_STAGE1_MAP_THRESHOLD_CHARS = "60000";
  });

  it("small corpus → exactly 1 GPT call (single path)", async () => {
    process.env.ORION_GPT_STAGE1_MAP_THRESHOLD_CHARS = "60000";
    let calls = 0;
    const analysis = await runGptCaseAnalysis({
      caller: async ({ systemPrompt }) => {
        calls += 1;
        assert.ok(
          systemPrompt.includes("ПОЛНЫЙ верифицированный аналитический корпус"),
          "small corpus must use single-call prompt"
        );
        assert.ok(!systemPrompt.includes(GPT_STAGE1_MAP_PROMPT_MARKER));
        return validCaseAnalysisJson();
      },
      subjectName: "Anders Holmström",
      bundle: MINI_BUNDLE,
      surfaceUnits: [],
      metricSnapshot: MINI_METRICS,
    });
    assert.ok(analysis);
    assert.equal(calls, 1);
  });

  it("large corpus → K map + 1 reduce", async () => {
    process.env.ORION_GPT_STAGE1_MAP_THRESHOLD_CHARS = "100";
    const fixture = largeCorpusFixture();
    const batches = splitCorpusIntoMapBatches({
      subjectName: "Anders Holmström",
      aliases: [],
      contextIdentifiers: [],
      bundle: fixture.bundle,
      surfaceUnits: fixture.surfaceUnits,
      metricSnapshot: fixture.metricSnapshot,
    });
    assert.ok(batches.length >= 3, `expected several batches, got ${batches.length}`);

    const stages: string[] = [];
    const analysis = await runGptCaseAnalysis({
      caller: async ({ systemPrompt }) => {
        if (systemPrompt.includes(GPT_STAGE1_MAP_PROMPT_MARKER)) {
          stages.push("map");
          return miniMapJson();
        }
        if (systemPrompt.includes(GPT_STAGE1_REDUCE_PROMPT_MARKER)) {
          stages.push("reduce");
          return validCaseAnalysisJson();
        }
        stages.push("single");
        return validCaseAnalysisJson();
      },
      subjectName: "Anders Holmström",
      bundle: fixture.bundle,
      surfaceUnits: fixture.surfaceUnits,
      metricSnapshot: fixture.metricSnapshot,
    });
    assert.ok(analysis);
    assert.equal(analysis!.version, "gpt-case-analysis-v1");
    assert.ok(analysis!.recommendations.length >= 1);
    assert.equal(stages.filter((s) => s === "map").length, batches.length);
    assert.equal(stages.filter((s) => s === "reduce").length, 1);
    assert.equal(stages.filter((s) => s === "single").length, 0);
  });

  it("one map batch fails → analysis still returned", async () => {
    const { OpenAiCallError } = await import(
      "../src/modules/digital-profile/orion-golden/gpt/gpt-call-queue"
    );
    process.env.ORION_GPT_STAGE1_MAP_THRESHOLD_CHARS = "100";
    const fixture = largeCorpusFixture();
    let mapCalls = 0;
    let reduceCalls = 0;
    const analysis = await runGptCaseAnalysis({
      caller: async ({ systemPrompt, userPayload }) => {
        if (systemPrompt.includes(GPT_STAGE1_MAP_PROMPT_MARKER)) {
          mapCalls += 1;
          const key = String((userPayload as { batchKey?: string }).batchKey ?? "");
          if (key === "ru_organic") {
            throw new OpenAiCallError("forced-map-fail", { retryable: false });
          }
          return miniMapJson();
        }
        if (systemPrompt.includes(GPT_STAGE1_REDUCE_PROMPT_MARKER)) {
          reduceCalls += 1;
          const dropped = (userPayload as { droppedBatches?: string[] }).droppedBatches ?? [];
          assert.ok(dropped.includes("ru_organic"), "failed map must be listed");
          return validCaseAnalysisJson();
        }
        throw new Error("unexpected single path");
      },
      subjectName: "Anders Holmström",
      bundle: fixture.bundle,
      surfaceUnits: fixture.surfaceUnits,
      metricSnapshot: fixture.metricSnapshot,
    });
    assert.ok(analysis, "partial map failure must not discard analysis");
    assert.ok(mapCalls >= 3);
    assert.equal(reduceCalls, 1);
  });

  it("reduce fails → null (fail-safe)", async () => {
    const { OpenAiCallError } = await import(
      "../src/modules/digital-profile/orion-golden/gpt/gpt-call-queue"
    );
    process.env.ORION_GPT_STAGE1_MAP_THRESHOLD_CHARS = "100";
    const fixture = largeCorpusFixture();
    let reason: string | null = null;
    const analysis = await runGptCaseAnalysis({
      caller: async ({ systemPrompt }) => {
        if (systemPrompt.includes(GPT_STAGE1_MAP_PROMPT_MARKER)) return miniMapJson();
        if (systemPrompt.includes(GPT_STAGE1_REDUCE_PROMPT_MARKER)) {
          throw new OpenAiCallError("forced-reduce-fail", { retryable: false });
        }
        throw new Error("unexpected single path");
      },
      subjectName: "Anders Holmström",
      bundle: fixture.bundle,
      surfaceUnits: fixture.surfaceUnits,
      metricSnapshot: fixture.metricSnapshot,
      onFailure: (r) => {
        reason = r;
      },
    });
    assert.equal(analysis, null);
    assert.ok(reason && /reduce/i.test(reason), reason ?? "");
  });
});

describe("honest empty-state slides — GPT must not invent surface data", () => {
  it("SKIPPED_EMPTY for coverage-empty SERP; invented GPT narrative discarded", async () => {
    const emptyDraft =
      "Органическая поисковая выдача по данному контуру проверена: материалов нет — это результат проверки.";
    const pack = {
      schemaVersion: SECTION_PACK_SCHEMA_VERSION,
      sectionId: "UAE_PROFILE",
      sectionType: "UAE_PROFILE",
      fragmentKey: "UAE_SERP",
      caseId: "c1",
      datasetId: "d1",
      reportRunId: "r1",
      sourceDatasetId: "d1",
      contentVersion: "deck-sections-v19",
      promptVersion: "uae-serp-analysis-v3",
      contentHash: "sha256:empty-serp",
      inputHash: "h-empty-serp",
      generatedAt: "2026-01-01T00:00:00.000Z",
      required: true,
      status: "READY",
      // Pack may still list regional findings — GPT must not use them here.
      sourceFindingIds: ["f-pep", "f-court"],
      evidenceRefs: [],
      inputs: { findingIds: ["f-pep", "f-court"], evidenceRefs: [], metricSnapshotId: "m1" },
      slides: [
        {
          schemaVersion: "slide-content-v1",
          slideId: "p26_uae_serp_table",
          baseSlotId: "p26_uae_serp_table",
          sectionId: "UAE_PROFILE",
          fragmentKey: "UAE_SERP",
          templateId: "coverage-empty-state",
          title: "ОАЭ — позиции в поисковой выдаче",
          findingIds: [],
          evidenceRefs: [],
          content: {
            narrative: emptyDraft,
            bullets: [
              "Проверено, материалов нет — это результат проверки на дату отчёта, а не вывод об отсутствии рисков.",
            ],
            whatToCheck: "Рекомендуем проверить региональные настройки сбора и повторить проверку.",
          },
          emptyStateReason: "no-organic-data",
          isContinuation: false,
          continuationOf: null,
          continuationIndex: null,
          visualAssetRefs: [],
          metrics: {},
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
    } as unknown as SectionPackV2;

    assert.equal(isHonestEmptyStateSlide(pack.slides[0]!), true);

    let calls = 0;
    const out = await enhanceSectionPacksWithGptCopy({
      packs: [pack],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async () => {
        calls += 1;
        return {
          slides: [
            {
              slideId: "p26_uae_serp_table",
              narrative:
                "В органической выдаче по ОАЭ профиль выглядит высокорисковым: 50 публикаций PEP и 21 судебная — сбор не запускался.",
              whatWasFound: "Выдумано из findings другого региона.",
            },
          ],
        };
      },
      caseAnalysis: null,
      bundle: MINI_BUNDLE,
      evidenceIndex: {},
      validatePack: () => ({ passed: true, issues: [] }),
    });

    assert.equal(calls, 0, "GPT must not be called for honest empty packs");
    assert.equal(out.report.fragments[0]?.status, "SKIPPED_EMPTY");
    assert.equal(out.packs[0]?.slides[0]?.content.narrative, emptyDraft);
    assert.ok(!String(out.packs[0]?.slides[0]?.content.narrative).includes("50 публикаций"));
  });

  it("SERP with only NO_RESULTS markers → coverage-empty, not a fake table", () => {
    const scoped = {
      subject: { displayName: "Test", aliases: [] as string[] },
      findings: [
        {
          findingId: "f-global",
          theme: "PEP / RCA / watchlist-сигналы",
          claim: "Глобальный finding не должен попасть на пустой UAE SERP.",
          riskLevel: "high",
          confidence: 0.9,
          subjectMatch: "SUBJECT_MATCH",
          evidenceRefs: ["inventory:ru-only"],
          sourceDomains: ["rupep.org"],
          recommendedAction: "Проверить",
          promotionPriority: "P1",
          limitations: [],
        },
      ],
      surfaceUnits: [
        {
          surface: "organic" as const,
          region: "UAE",
          engine: "GOOGLE",
          metrics: [
            { key: "totalCount", value: 0, sampleStatus: "MEASURED" as const, denominator: 0 },
            { key: "emptyMarkerCount", value: 1, sampleStatus: "MEASURED" as const },
          ],
          claims: [],
          evidenceRefs: ["inventory:uae-empty"],
        },
      ],
      metricSnapshot: MINI_METRICS,
      scope: fragmentScope("UAE_SERP"),
      evidenceIndex: {
        "inventory:uae-empty": {
          title: "Результаты не найдены",
          domain: "—",
          region: "UAE",
          kind: "organic",
        },
      },
    };
    const out = buildSerpFragment("UAE_SERP", "UAE_PROFILE", "ОАЭ", scoped as never);
    assert.equal(out.slides.length, 1);
    assert.equal(out.slides[0]?.templateId, "coverage-empty-state");
    assert.equal(out.slides[0]?.emptyStateReason, "no-organic-data");
    assert.equal(out.slides[0]?.findingIds.length, 0);
    assert.match(String(out.slides[0]?.content.narrative), /проверен|не собиралась|не зафиксир/i);
    assert.ok(!String(out.slides[0]?.content.narrative).includes("50"));
  });
});

describe("REMEDIATION §7.5 GPT stage-2 density", () => {
  function densityPack(): SectionPackV2 {
    return {
      schemaVersion: SECTION_PACK_SCHEMA_VERSION,
      sectionId: "RU_PROFILE",
      sectionType: "RU_PROFILE",
      fragmentKey: "RU_SERP",
      caseId: "c1",
      datasetId: "d1",
      reportRunId: "r1",
      sourceDatasetId: "d1",
      contentVersion: "deck-sections-v18",
      promptVersion: "ru-serp-analysis-v3",
      contentHash: "sha256:density",
      inputHash: "h-density",
      generatedAt: "2026-01-01T00:00:00.000Z",
      required: true,
      status: "READY",
      sourceFindingIds: ["f1"],
      evidenceRefs: ["inventory:a"],
      inputs: { findingIds: ["f1"], evidenceRefs: ["inventory:a"], metricSnapshotId: "m1" },
      slides: [
        {
          schemaVersion: "slide-content-v1",
          slideId: "p10_ru_serp",
          baseSlotId: "p10_ru_serp",
          sectionId: "RU_PROFILE",
          fragmentKey: "RU_SERP",
          templateId: "serp-table",
          title: "Россия — позиции в поисковой выдаче",
          findingIds: ["f1"],
          evidenceRefs: ["inventory:a"],
          content: {
            narrative: "Краткий черновик.",
            whatWasFound: "",
            whyItMatters: "",
            whatToCheck: "",
            bullets: ["Черновой пункт."],
          },
        },
      ],
      metrics: {
        datasetCount: 1,
        displayedCount: 1,
        adverseDatasetCount: 1,
        adverseDisplayedCount: 1,
      },
      provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: ["inventory:a"] },
      validation: { passed: true, issues: [] },
    } as unknown as SectionPackV2;
  }

  function padTo(minChars: number, seed: string): string {
    let out = seed;
    while (out.length < minChars) out += ` ${seed}`;
    return out.slice(0, Math.max(minChars, seed.length));
  }

  it("prompt requires fill-all fields and length floors; dense caller beats sparse baseline", async () => {
    const pack = densityPack();
    let sawDensityMarker = false;

    const sparse = await enhanceSectionPacksWithGptCopy({
      packs: [structuredClone(pack)],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async ({ systemPrompt }) => {
        if (systemPrompt.includes(GPT_SLIDE_COPY_DENSITY_MARKER)) sawDensityMarker = true;
        return {
          slides: [
            {
              slideId: "p10_ru_serp",
              narrative: "Короткий переписанный вывод без деталей.",
            },
          ],
        };
      },
      caseAnalysis: null,
      bundle: MINI_BUNDLE,
      evidenceIndex: {
        "inventory:a": { domain: "di.se", title: "Tax probe", adverse: true },
      },
      validatePack: () => ({ passed: true, issues: [] }),
    });
    assert.ok(sawDensityMarker, "stage-2 system prompt must carry §7.5 density marker");

    const dense = await enhanceSectionPacksWithGptCopy({
      packs: [structuredClone(pack)],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async () => ({
        slides: [
          {
            slideId: "p10_ru_serp",
            narrative: padTo(
              Math.ceil(GPT_SLIDE_COPY_FIELD_BUDGETS.narrative * 0.42),
              "По выдаче видны публикации о налоговой проверке основателя Nordkap; это повышает комплаенс-риск при банковских и партнёрских проверках."
            ),
            whatWasFound: padTo(
              Math.ceil(GPT_SLIDE_COPY_FIELD_BUDGETS.whatWasFound * 0.42),
              "Зафиксированы материалы по теме финансовых претензий; источники включают di.se."
            ),
            whyItMatters: padTo(
              Math.ceil(GPT_SLIDE_COPY_FIELD_BUDGETS.whyItMatters * 0.42),
              "Такие сигналы влияют на решения банков и контрагентов о сотрудничестве."
            ),
            whatToCheck: padTo(
              Math.ceil(GPT_SLIDE_COPY_FIELD_BUDGETS.whatToCheck * 0.42),
              "Подтвердить статус расследования и подготовить официальный комментарий."
            ),
            bullets: [
              padTo(
                Math.ceil(GPT_SLIDE_COPY_FIELD_BUDGETS.bullet * 0.42),
                "Тема риска: финансовые претензии; требуется проверка первоисточника di.se."
              ),
            ],
          },
        ],
      }),
      caseAnalysis: null,
      bundle: MINI_BUNDLE,
      evidenceIndex: {
        "inventory:a": { domain: "di.se", title: "Tax probe", adverse: true },
      },
      validatePack: () => ({ passed: true, issues: [] }),
    });

    const sparseStats = measureSlideCopyDensity(sparse.packs[0]!.slides);
    const denseStats = measureSlideCopyDensity(dense.packs[0]!.slides);
    assert.ok(sparseStats.dataSlides >= 1);
    assert.ok(denseStats.dataSlides >= 1);
    assert.ok(
      denseStats.fieldFillRatio > sparseStats.fieldFillRatio,
      `fill dense=${denseStats.fieldFillRatio} sparse=${sparseStats.fieldFillRatio}`
    );
    assert.ok(
      denseStats.avgLengthRatio > sparseStats.avgLengthRatio,
      `length dense=${denseStats.avgLengthRatio} sparse=${sparseStats.avgLengthRatio}`
    );
    assert.ok(denseStats.fieldFillRatio >= 0.8, `dense fill=${denseStats.fieldFillRatio}`);
    assert.ok(dense.report.fragments[0]?.status === "APPLIED");
    assert.equal(dense.report.promptVersion, GPT_SLIDE_COPY_PROMPT_VERSION);
  });
});

describe("stage 2 — forceRefresh bypasses SKIPPED_CACHED", () => {
  it("re-calls GPT for packs that would otherwise be cache hits", async () => {
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
      gptCopy: {
        promptVersion: GPT_SLIDE_COPY_PROMPT_VERSION,
        appliedSlides: 1,
        caseAnalysisUsed: true,
        lastStatus: "APPLIED",
      },
    } as unknown as SectionPackV2;

    const analysis = (await runGptCaseAnalysis({
      caller: async () => validCaseAnalysisJson(),
      subjectName: "Anders Holmström",
      bundle: MINI_BUNDLE,
      surfaceUnits: [],
      metricSnapshot: MINI_METRICS,
    }))!;

    let cachedCalls = 0;
    const cached = await enhanceSectionPacksWithGptCopy({
      packs: [pack],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async () => {
        cachedCalls += 1;
        return { slides: [] };
      },
      caseAnalysis: analysis,
      bundle: MINI_BUNDLE,
      evidenceIndex: {},
      validatePack: () => ({ passed: true, issues: [] }),
    });
    assert.equal(cachedCalls, 0);
    assert.equal(cached.report.fragments[0]?.status, "SKIPPED_CACHED");

    let forcedCalls = 0;
    const forced = await enhanceSectionPacksWithGptCopy({
      packs: [pack],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async () => {
        forcedCalls += 1;
        return {
          slides: [
            {
              slideId: "p03_executive",
              narrative: `${GPT_NARRATIVE_MARKER}: принудительное обновление копирайта после пересборки.`,
            },
          ],
        };
      },
      caseAnalysis: analysis,
      bundle: MINI_BUNDLE,
      evidenceIndex: {},
      validatePack: () => ({ passed: true, issues: [] }),
      forceRefresh: true,
    });
    assert.equal(forcedCalls, 1, "forceRefresh must re-call GPT");
    assert.equal(forced.report.fragments[0]?.status, "APPLIED");
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

  it("second full prepare re-runs stage 2 (no SKIPPED_CACHED from prior gptCopy)", async () => {
    const root = tmp("gpt-copy-full-rerun-");
    const input1 = await seededPrepareInput(root, makeHappyCaller());
    const res1 = await runCanonicalReportPrepare(input1);
    assert.equal(res1.ok, true);
    const report1 = readGptReport(root);
    assert.ok(report1.fragments.some((f) => f.status === "APPLIED"));
    assert.equal(
      report1.fragments.filter((f) => f.status === "SKIPPED_CACHED").length,
      0
    );

    let stage2Hits = 0;
    const countingCaller: GptJsonCaller = async ({ systemPrompt, userPayload }) => {
      if (systemPrompt.includes("ПОЛНЫЙ верифицированный аналитический корпус")) {
        return validCaseAnalysisJson();
      }
      stage2Hits += 1;
      const payload = userPayload as { slides: Array<{ slideId: string; title: string }> };
      return {
        slides: payload.slides.map((s) => ({
          slideId: s.slideId,
          narrative: `${GPT_NARRATIVE_MARKER}: повтор «${s.title}».`,
          whatToCheck: "Проверить первоисточник после полной пересборки.",
        })),
      };
    };
    const res2 = await runCanonicalReportPrepare({
      ...input1,
      gptCaller: countingCaller,
      resumeFrom: "full",
    });
    assert.equal(res2.ok, true);
    assert.ok(stage2Hits >= 3, `full prepare must re-call stage 2, hits=${stage2Hits}`);
    const report2 = readGptReport(root);
    assert.equal(
      report2.fragments.filter((f) => f.status === "SKIPPED_CACHED").length,
      0,
      "full prepare must never report SKIPPED_CACHED"
    );
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

// ---------- REMEDIATION §4.3 — selective FALLBACK retry ----------

describe("stage 2 — gpt-copy resume retries FALLBACK_* only", () => {
  it("fail 2 fragments → resumeFrom gpt-copy applies them → second resume SKIPPED_CACHED", async () => {
    const { OpenAiCallError } = await import(
      "../src/modules/digital-profile/orion-golden/gpt/gpt-call-queue"
    );
    const { loadPreviousPacks } = await import(
      "../src/modules/digital-profile/orion-golden/deck-sections/run-deck-build"
    );

    const failKeys = new Set(["EXECUTIVE_SUMMARY", "RU_SERP"]);
    const root = tmp("gpt-copy-retry-");

    const firstCaller: GptJsonCaller = async ({ systemPrompt, userPayload }) => {
      if (systemPrompt.includes("ПОЛНЫЙ верифицированный аналитический корпус")) {
        return validCaseAnalysisJson();
      }
      const payload = userPayload as {
        fragmentKey?: string;
        slides: Array<{ slideId: string; title: string }>;
      };
      const key = String(payload.fragmentKey ?? "");
      if (failKeys.has(key)) {
        // Non-retryable so the queue does not multiply attempts under §4.2.
        throw new OpenAiCallError(`forced-fallback:${key}`, { retryable: false });
      }
      return {
        slides: payload.slides.map((s) => ({
          slideId: s.slideId,
          narrative: `${GPT_NARRATIVE_MARKER}: ok «${s.title}».`,
          whatToCheck: "Проверить первоисточник.",
        })),
      };
    };

    const input1 = await seededPrepareInput(root, firstCaller);
    const res1 = await runCanonicalReportPrepare(input1);
    assert.equal(res1.ok, true);
    const report1 = readGptReport(root);
    const fallbacks1 = report1.fragments.filter((f) => f.status.startsWith("FALLBACK_"));
    assert.equal(fallbacks1.length, 2, fallbacks1.map((f) => f.fragmentKey).join(","));
    const fallbackKeys = fallbacks1.map((f) => f.fragmentKey);
    assert.ok(fallbackKeys.includes("EXECUTIVE_SUMMARY"));
    assert.ok(fallbackKeys.includes("RU_SERP"));

    const packs1 = loadPreviousPacks(join(root, "deck"));
    for (const key of fallbackKeys) {
      const pack = packs1.get(key as never);
      assert.ok(pack?.gptCopy?.lastStatus?.startsWith("FALLBACK_"), key);
    }

    let retryHits = 0;
    const retryCaller: GptJsonCaller = async ({ systemPrompt, userPayload }) => {
      if (systemPrompt.includes("ПОЛНЫЙ верифицированный аналитический корпус")) {
        return validCaseAnalysisJson();
      }
      retryHits += 1;
      const payload = userPayload as {
        fragmentKey?: string;
        slides: Array<{ slideId: string; title: string }>;
      };
      assert.ok(
        failKeys.has(String(payload.fragmentKey ?? "")),
        `retry must only call FALLBACK keys, got ${payload.fragmentKey}`
      );
      return {
        slides: payload.slides.map((s) => ({
          slideId: s.slideId,
          narrative: `${GPT_NARRATIVE_MARKER}: retry «${s.title}».`,
          whatToCheck: "Проверить первоисточник после retry.",
        })),
      };
    };

    const res2 = await runCanonicalReportPrepare({
      ...input1,
      gptCaller: retryCaller,
      resumeFrom: "gpt-copy",
    });
    assert.equal(res2.ok, true);
    assert.equal(res2.assemblyCount, 1);
    assert.equal(retryHits, 2, `retry GPT hits=${retryHits}`);

    const report2 = readGptReport(root);
    for (const key of fallbackKeys) {
      const frag = report2.fragments.find((f) => f.fragmentKey === key);
      assert.equal(frag?.status, "APPLIED", `${key} → ${frag?.status}`);
    }
    assert.equal(
      report2.fragments.filter((f) => f.status.startsWith("FALLBACK_")).length,
      0
    );

    let secondHits = 0;
    const cachedCaller: GptJsonCaller = async ({ systemPrompt, userPayload }) => {
      if (systemPrompt.includes("ПОЛНЫЙ верифицированный аналитический корпус")) {
        return validCaseAnalysisJson();
      }
      secondHits += 1;
      const payload = userPayload as { slides: Array<{ slideId: string; title: string }> };
      return {
        slides: payload.slides.map((s) => ({
          slideId: s.slideId,
          narrative: `${GPT_NARRATIVE_MARKER}: should-not-apply.`,
        })),
      };
    };
    const res3 = await runCanonicalReportPrepare({
      ...input1,
      gptCaller: cachedCaller,
      resumeFrom: "gpt-copy",
    });
    assert.equal(res3.ok, true);
    assert.equal(secondHits, 0, "no FALLBACK left → zero stage-2 GPT calls");
    const report3 = readGptReport(root);
    for (const key of fallbackKeys) {
      assert.equal(
        report3.fragments.find((f) => f.fragmentKey === key)?.status,
        "SKIPPED_CACHED",
        key
      );
    }
  });
});
