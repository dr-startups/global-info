/**
 * REMEDIATION §4.4 — GPT stage-1 map-reduce for large corpora.
 *
 * When the serialized corpus payload exceeds a char threshold, the corpus is
 * split into semantic surface/region batches. Each batch gets a mini-analysis;
 * a reduce call merges minis (+ metrics) into the same GptCaseAnalysis schema
 * consumers already expect. Partial map failures are dropped from reduce with
 * diagnostics; reduce failure → null (fail-safe).
 */

import { z } from "zod";
import type { Finding } from "../contracts/finding";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { SurfaceAnalysisUnit } from "../contracts/surface-analysis";
import type { MetricSnapshot } from "../deck-sections/scoped-input";
import { riskLevelPromptLine } from "./case-verdict";

/** Добавляет к промпту строку с вычисленным уровнем риска, если он известен. */
function withRiskLevelLine(prompt: string, verdict?: string | null): string {
  const line = riskLevelPromptLine(verdict);
  return line ? `${prompt} ${line}` : prompt;
}
import {
  buildCorpusPayload,
  CASE_ANALYSIS_SYSTEM_PROMPT,
  caseAnalysisSystemPrompt,
  clampCaseAnalysisText,
  clientSafeCaseAnalysisText,
  finalizeGptCaseAnalysis,
  GPT_CASE_ANALYSIS_BUDGETS,
  KeyRiskSchema,
  type GptCaseAnalysis,
  type GptCaseAnalysisDiagnostics,
  type GptCaseAnalysisRunInput,
  type GptJsonCaller,
} from "./gpt-case-analysis";

export type { GptCaseAnalysisDiagnostics };
import {
  defaultGptCallQueueOptions,
  runGptCallQueue,
  type GptCallQueueOptions,
} from "./gpt-call-queue";

export type GptCaseAnalysisMapBatchKey =
  | "ru_organic"
  | "uae_organic"
  | "suggest_paa"
  | "images_ai"
  | "compliance";

export type GptCaseAnalysisMapBatch = {
  key: GptCaseAnalysisMapBatchKey;
  labelRu: string;
  findings: Finding[];
  surfaces: SurfaceAnalysisUnit[];
};

export const GptCaseAnalysisMiniSchema = z.object({
  keyRisks: z.array(KeyRiskSchema).max(6).default([]),
  notableFacts: z
    .array(z.string().min(1).max(GPT_CASE_ANALYSIS_BUDGETS.positiveSignal))
    .max(12)
    .default([]),
  positiveSignals: z
    .array(z.string().min(1).max(GPT_CASE_ANALYSIS_BUDGETS.positiveSignal))
    .max(6)
    .default([]),
});

export type GptCaseAnalysisMini = z.infer<typeof GptCaseAnalysisMiniSchema> & {
  batchKey: GptCaseAnalysisMapBatchKey;
};

const BATCH_ORDER: GptCaseAnalysisMapBatchKey[] = [
  "ru_organic",
  "uae_organic",
  "suggest_paa",
  "images_ai",
  "compliance",
];

const BATCH_LABEL_RU: Record<GptCaseAnalysisMapBatchKey, string> = {
  ru_organic: "органическая выдача RU",
  uae_organic: "органическая выдача UAE",
  suggest_paa: "подсказки и связанные вопросы",
  images_ai: "изображения, AI-ответы и справочные карточки",
  compliance: "комплаенс и URL-аудит",
};

const BATCH_SURFACES: Record<GptCaseAnalysisMapBatchKey, Set<string>> = {
  ru_organic: new Set(["organic"]),
  uae_organic: new Set(["organic"]),
  suggest_paa: new Set(["suggestions", "paa_related"]),
  images_ai: new Set(["images", "ai_answers", "wikipedia"]),
  compliance: new Set(["compliance", "url_audit"]),
};

const MAP_SYSTEM_PROMPT = [
  "Ты — аналитик reputational due diligence.",
  "Тебе передан ЧАСТИЧНЫЙ верифицированный корпус (один батч поверхностей). Сделай мини-анализ только по этим данным.",
  "Не выдумывай фактов вне переданного батча. Пиши по-русски, без внутренних технических терминов и URL.",
  "Лимиты: keyRisks ≤ 6 (theme ≤ 160, explanation ≤ 700, advice ≤ 400); notableFacts/positiveSignals item ≤ 400.",
  'Верни ТОЛЬКО JSON: {"keyRisks":[{"theme":string,"severity":"низкий|средний|высокий|критический","explanation":string,"advice":string}],"notableFacts":[string],"positiveSignals":[string]}.',
].join(" ");

const REDUCE_SYSTEM_PROMPT = [
  "Ты — старший аналитик reputational due diligence.",
  "Тебе переданы мини-анализы частей корпуса и общие метрики. Сведи их в ОДИН целостный клиентский анализ кейса.",
  "Не добавляй фактов, которых нет в мини-анализах. Пиши по-русски; каждый риск объясняй и давай совет.",
  "Лимиты длины (символы, жёстко): executiveConclusion ≤ 1400; digitalPortrait ≤ 1000; keyRisks.theme ≤ 160; keyRisks.explanation ≤ 700; keyRisks.advice ≤ 400; positiveSignals/recommendations item ≤ 400.",
  "Строгие запреты: не используй внутренние технические термины (audit, reportRunId, pipeline, dataset, provider); не вставляй URL.",
  'Верни ТОЛЬКО JSON по схеме: {"overallRiskLevel":"низкий|средний|высокий|критический","executiveConclusion":string,"digitalPortrait":string,"keyRisks":[{"theme":string,"severity":"низкий|средний|высокий|критический","explanation":string,"advice":string}],"positiveSignals":[string],"recommendations":[string]}.',
].join(" ");

type CorpusInput = {
  subjectName: string;
  aliases: string[];
  contextIdentifiers: string[];
  bundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
};

export function readStage1MapThresholdChars(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(env.ORION_GPT_STAGE1_MAP_THRESHOLD_CHARS ?? 60_000);
  // Allow low values in offline tests that force map-reduce; reject non-numeric.
  if (!Number.isFinite(raw) || raw < 1) return 60_000;
  return Math.floor(raw);
}

export function estimateCorpusPayloadChars(input: CorpusInput): number {
  return JSON.stringify(buildCorpusPayload(input)).length;
}

function classifySurface(unit: SurfaceAnalysisUnit): GptCaseAnalysisMapBatchKey {
  const surface = String(unit.surface ?? "");
  if (BATCH_SURFACES.compliance.has(surface)) return "compliance";
  if (BATCH_SURFACES.suggest_paa.has(surface)) return "suggest_paa";
  if (BATCH_SURFACES.images_ai.has(surface)) return "images_ai";
  const region = String(unit.region ?? "").toUpperCase();
  if (region === "UAE") return "uae_organic";
  return "ru_organic";
}

function classifyFinding(finding: Finding): GptCaseAnalysisMapBatchKey {
  const kinds = (finding.surfaceKinds ?? []).map((k) => String(k));
  if (kinds.some((k) => BATCH_SURFACES.compliance.has(k))) return "compliance";
  if (kinds.some((k) => BATCH_SURFACES.suggest_paa.has(k))) return "suggest_paa";
  if (kinds.some((k) => BATCH_SURFACES.images_ai.has(k))) return "images_ai";
  if (kinds.includes("organic")) {
    const regions = finding.regions.map((r) => String(r).toUpperCase());
    if (regions.includes("UAE") && !regions.includes("RU")) return "uae_organic";
    return "ru_organic";
  }
  const regions = finding.regions.map((r) => String(r).toUpperCase());
  if (regions.includes("UAE") && !regions.includes("RU")) return "uae_organic";
  const theme = `${finding.theme} ${finding.claim}`.toLowerCase();
  if (/санкц|комплаенс|pep|watchlist|lexis|ofac|compliance/i.test(theme)) {
    return "compliance";
  }
  return "ru_organic";
}

export function splitCorpusIntoMapBatches(
  input: CorpusInput
): GptCaseAnalysisMapBatch[] {
  const byKey = new Map<GptCaseAnalysisMapBatchKey, GptCaseAnalysisMapBatch>();
  for (const key of BATCH_ORDER) {
    byKey.set(key, {
      key,
      labelRu: BATCH_LABEL_RU[key],
      findings: [],
      surfaces: [],
    });
  }

  for (const unit of input.surfaceUnits) {
    const key = classifySurface(unit);
    byKey.get(key)!.surfaces.push(unit);
  }
  for (const finding of input.bundle.findings) {
    const key = classifyFinding(finding);
    byKey.get(key)!.findings.push(finding);
  }

  return BATCH_ORDER.map((k) => byKey.get(k)!)
    .filter((b) => b.findings.length > 0 || b.surfaces.length > 0);
}

function buildMapBatchPayload(
  corpus: CorpusInput,
  batch: GptCaseAnalysisMapBatch
): Record<string, unknown> {
  const partialBundle: VerifiedFindingBundle = {
    ...corpus.bundle,
    findings: batch.findings,
  };
  const base = buildCorpusPayload({
    ...corpus,
    bundle: partialBundle,
    surfaceUnits: batch.surfaces,
  });
  return {
    batchKey: batch.key,
    batchLabel: batch.labelRu,
    ...base,
  };
}

function coerceMiniRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (Array.isArray(o.keyRisks)) {
    o.keyRisks = o.keyRisks.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const r = { ...(item as Record<string, unknown>) };
      if (typeof r.theme === "string") {
        r.theme = clampCaseAnalysisText(r.theme, GPT_CASE_ANALYSIS_BUDGETS.theme);
      }
      if (typeof r.explanation === "string") {
        r.explanation = clampCaseAnalysisText(
          r.explanation,
          GPT_CASE_ANALYSIS_BUDGETS.explanation
        );
      }
      if (typeof r.advice === "string") {
        r.advice = clampCaseAnalysisText(r.advice, GPT_CASE_ANALYSIS_BUDGETS.advice);
      }
      return r;
    });
  }
  if (Array.isArray(o.notableFacts)) {
    o.notableFacts = o.notableFacts.map((item) =>
      typeof item === "string"
        ? clampCaseAnalysisText(item, GPT_CASE_ANALYSIS_BUDGETS.positiveSignal)
        : item
    );
  }
  if (Array.isArray(o.positiveSignals)) {
    o.positiveSignals = o.positiveSignals.map((item) =>
      typeof item === "string"
        ? clampCaseAnalysisText(item, GPT_CASE_ANALYSIS_BUDGETS.positiveSignal)
        : item
    );
  }
  return o;
}

function finalizeMini(
  batchKey: GptCaseAnalysisMapBatchKey,
  raw: unknown
): GptCaseAnalysisMini | null {
  const parsed = GptCaseAnalysisMiniSchema.safeParse(coerceMiniRaw(raw));
  if (!parsed.success) return null;
  const keyRisks = parsed.data.keyRisks.filter(
    (r) =>
      clientSafeCaseAnalysisText(r.theme) &&
      clientSafeCaseAnalysisText(r.explanation) &&
      clientSafeCaseAnalysisText(r.advice)
  );
  const notableFacts = parsed.data.notableFacts.filter(clientSafeCaseAnalysisText);
  const positiveSignals = parsed.data.positiveSignals.filter(
    clientSafeCaseAnalysisText
  );
  if (keyRisks.length === 0 && notableFacts.length === 0 && positiveSignals.length === 0) {
    return null;
  }
  return { batchKey, keyRisks, notableFacts, positiveSignals };
}

function queueOptionsForStage1(
  overrides?: GptCallQueueOptions
): GptCallQueueOptions {
  const defaults = defaultGptCallQueueOptions();
  const offlineSleep =
    process.env.NETWORK_CALLS === "0" ? async () => undefined : undefined;
  return {
    concurrency: defaults.concurrency,
    maxAttempts: defaults.maxAttempts,
    deadlineMs: defaults.deadlineMs,
    sleep: offlineSleep,
    ...overrides,
  };
}

/**
 * Map-reduce stage 1. Prefer `runGptCaseAnalysis`, which routes here when the
 * corpus exceeds the char threshold and yields more than one batch.
 */
export async function runGptCaseAnalysisMapReduce(
  input: GptCaseAnalysisRunInput
): Promise<GptCaseAnalysis | null> {
  const fail = (reason: string): null => {
    input.onFailure?.(reason);
    return null;
  };

  const corpus: CorpusInput = {
    subjectName: input.subjectName,
    aliases: input.aliases ?? [],
    contextIdentifiers: input.contextIdentifiers ?? [],
    bundle: input.bundle,
    surfaceUnits: input.surfaceUnits,
    metricSnapshot: input.metricSnapshot,
  };

  const batches = splitCorpusIntoMapBatches(corpus);
  const thresholdChars = readStage1MapThresholdChars();
  const payloadChars = estimateCorpusPayloadChars(corpus);

  if (batches.length === 0) {
    input.onDiagnostics?.({
      mode: "map_reduce",
      thresholdChars,
      payloadChars,
      mapCalls: 0,
      reduceCall: false,
      batchKeys: [],
      mapFailures: [{ batch: "ru_organic", reason: "no-batches" }],
    });
    return fail("map: no batches");
  }

  // Degenerate: one batch → single full-schema call (still via queue).
  if (batches.length === 1) {
    input.onDiagnostics?.({
      mode: "single",
      thresholdChars,
      payloadChars,
      mapCalls: 0,
      reduceCall: false,
      batchKeys: batches.map((b) => b.key),
    });
    try {
      const queued = await runGptCallQueue({
        tasks: [
          {
            key: "gpt-stage1-single",
            run: () =>
              input.caller({
                systemPrompt: caseAnalysisSystemPrompt(input.deterministicVerdict),
                userPayload: buildCorpusPayload(corpus),
              }),
          },
        ],
        options: queueOptionsForStage1({
          concurrency: 1,
          ...input.queueOptions,
        }),
      });
      const result = queued[0];
      if (!result || !result.ok) {
        return fail(
          `transport: ${
            result && !result.ok ? result.error.message : "gpt-stage1-missing-result"
          }`
        );
      }
      return finalizeGptCaseAnalysis(result.value, input.onFailure, input.deterministicVerdict);
    } catch (err) {
      return fail(`transport: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const mapFailures: Array<{ batch: GptCaseAnalysisMapBatchKey; reason: string }> =
    [];
  const mapQueued = await runGptCallQueue({
    tasks: batches.map((batch) => ({
      key: `gpt-stage1-map:${batch.key}`,
      run: () =>
        input.caller({
          systemPrompt: MAP_SYSTEM_PROMPT,
          userPayload: buildMapBatchPayload(corpus, batch),
        }),
    })),
    options: queueOptionsForStage1(input.queueOptions),
  });

  const minis: GptCaseAnalysisMini[] = [];
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i]!;
    const queued = mapQueued[i];
    if (!queued || !queued.ok) {
      mapFailures.push({
        batch: batch.key,
        reason:
          queued && !queued.ok
            ? queued.error.message
            : "gpt-stage1-map-missing-result",
      });
      continue;
    }
    const mini = finalizeMini(batch.key, queued.value);
    if (!mini) {
      mapFailures.push({ batch: batch.key, reason: "map-schema-or-unsafe" });
      continue;
    }
    minis.push(mini);
  }

  if (minis.length === 0) {
    input.onDiagnostics?.({
      mode: "map_reduce",
      thresholdChars,
      payloadChars,
      mapCalls: batches.length,
      reduceCall: false,
      batchKeys: batches.map((b) => b.key),
      mapFailures,
    });
    return fail("map: all batches failed");
  }

  const reducePayload = {
    subject: {
      displayName: corpus.subjectName,
      aliases: corpus.aliases,
      businessContext: corpus.contextIdentifiers,
    },
    metrics: {
      totalMaterials: corpus.metricSnapshot.compositeCount,
      subjectMatches: corpus.metricSnapshot.subjectMatchCount,
      ambiguous: corpus.metricSnapshot.ambiguousCount,
      otherSubject: corpus.metricSnapshot.otherSubjectCount,
      adverseFindings: corpus.metricSnapshot.adverseFindingCount,
      perRegion: corpus.metricSnapshot.perRegionCounts,
    },
    mapResults: minis.map((m) => ({
      batchKey: m.batchKey,
      batchLabel: BATCH_LABEL_RU[m.batchKey],
      keyRisks: m.keyRisks,
      notableFacts: m.notableFacts,
      positiveSignals: m.positiveSignals,
    })),
    droppedBatches: mapFailures.map((f) => f.batch),
  };

  try {
    const reduceQueued = await runGptCallQueue({
      tasks: [
        {
          key: "gpt-stage1-reduce",
          run: () =>
            input.caller({
              // Свод тоже получает вычисленный уровень: иначе он предложит свой,
              // и объяснение разойдётся с плашкой по смыслу (шаг 07.9).
              systemPrompt: withRiskLevelLine(REDUCE_SYSTEM_PROMPT, input.deterministicVerdict),
              userPayload: reducePayload,
            }),
        },
      ],
      options: queueOptionsForStage1({
        concurrency: 1,
        ...input.queueOptions,
      }),
    });
    const reduceResult = reduceQueued[0];
    if (!reduceResult || !reduceResult.ok) {
      input.onDiagnostics?.({
        mode: "map_reduce",
        thresholdChars,
        payloadChars,
        mapCalls: batches.length,
        reduceCall: true,
        batchKeys: batches.map((b) => b.key),
        mapFailures,
      });
      return fail(
        `reduce: ${
          reduceResult && !reduceResult.ok
            ? reduceResult.error.message
            : "gpt-stage1-reduce-missing-result"
        }`
      );
    }

    const analysis = finalizeGptCaseAnalysis(
      reduceResult.value,
      input.onFailure,
      input.deterministicVerdict
    );
    input.onDiagnostics?.({
      mode: "map_reduce",
      thresholdChars,
      payloadChars,
      mapCalls: batches.length,
      reduceCall: true,
      batchKeys: batches.map((b) => b.key),
      ...(mapFailures.length > 0 ? { mapFailures } : {}),
    });
    return analysis;
  } catch (err) {
    input.onDiagnostics?.({
      mode: "map_reduce",
      thresholdChars,
      payloadChars,
      mapCalls: batches.length,
      reduceCall: true,
      batchKeys: batches.map((b) => b.key),
      mapFailures,
    });
    return fail(`reduce: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** @internal — exported for smokes that need prompt markers. */
export const GPT_STAGE1_MAP_PROMPT_MARKER = "ЧАСТИЧНЫЙ верифицированный корпус";
export const GPT_STAGE1_REDUCE_PROMPT_MARKER = "мини-анализы частей корпуса";

// Keep GptJsonCaller referenced for API docs / re-exports.
export type { GptJsonCaller };
