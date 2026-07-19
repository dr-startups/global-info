/**
 * GPT stage 1 — full-corpus case analysis.
 *
 * Before any slide copy is written, the model receives the ENTIRE verified
 * analytical picture of the subject (all findings, per-surface claims and
 * metrics) and produces a holistic client-language assessment: overall risk,
 * key risk themes with "why this is risky" explanations and advice, positive
 * signals and prioritized recommendations. The result is persisted as an
 * artifact and injected into every per-slide prompt so all slides speak with
 * one consistent analytical voice.
 *
 * Fail-safe: any transport/schema/sanitization failure returns null — the
 * report is then produced without the GPT layer (deterministic copy).
 */

import { z } from "zod";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import type { SurfaceAnalysisUnit } from "../contracts/surface-analysis";
import type { MetricSnapshot } from "../deck-sections/scoped-input";
import { scanOrionGoldenClientTextForForbiddenTokens } from "../client/client-text-sanitizer";
import { engineRu, metricKeyRu, riskLevelRu, subjectMatchRu, surfaceRu } from "./client-payload-labels";

export const GPT_CASE_ANALYSIS_VERSION = "gpt-case-analysis-v1" as const;

/** Strict JSON caller (system prompt + payload → parsed JSON). */
export type GptJsonCaller = (input: {
  systemPrompt: string;
  userPayload: unknown;
}) => Promise<unknown>;

const RiskWordSchema = z.enum(["низкий", "средний", "высокий", "критический"]);

/** Field budgets — keep in sync with prompt length hints below. */
export const GPT_CASE_ANALYSIS_BUDGETS = {
  theme: 160,
  explanation: 700,
  advice: 400,
  executiveConclusion: 1400,
  digitalPortrait: 1000,
  positiveSignal: 400,
  recommendation: 400,
} as const;

const KeyRiskSchema = z.object({
  theme: z.string().min(1).max(GPT_CASE_ANALYSIS_BUDGETS.theme),
  severity: RiskWordSchema,
  /** Client-language explanation of WHY this is risky for the subject. */
  explanation: z.string().min(1).max(GPT_CASE_ANALYSIS_BUDGETS.explanation),
  /** What the client should do about it. */
  advice: z.string().min(1).max(GPT_CASE_ANALYSIS_BUDGETS.advice),
});

export const GptCaseAnalysisSchema = z.object({
  overallRiskLevel: RiskWordSchema,
  /** 2–5 sentence executive conclusion in client language. */
  executiveConclusion: z.string().min(1).max(GPT_CASE_ANALYSIS_BUDGETS.executiveConclusion),
  /** How the subject currently looks to someone who searches for them. */
  digitalPortrait: z.string().max(GPT_CASE_ANALYSIS_BUDGETS.digitalPortrait).optional(),
  keyRisks: z.array(KeyRiskSchema).max(10),
  positiveSignals: z
    .array(z.string().min(1).max(GPT_CASE_ANALYSIS_BUDGETS.positiveSignal))
    .max(10)
    .default([]),
  recommendations: z
    .array(z.string().min(1).max(GPT_CASE_ANALYSIS_BUDGETS.recommendation))
    .min(1)
    .max(10),
});

export type GptCaseAnalysis = z.infer<typeof GptCaseAnalysisSchema> & {
  version: typeof GPT_CASE_ANALYSIS_VERSION;
  generatedAt: string;
};

export const GPT_CASE_ANALYSIS_PROMPT_VERSION = "gpt-case-analysis-prompt-v2";

const CASE_ANALYSIS_SYSTEM_PROMPT = [
  "Ты — старший аналитик reputational due diligence, готовящий клиентский отчёт о цифровом профиле проверяемого лица.",
  "Тебе передан ПОЛНЫЙ верифицированный аналитический корпус: все findings (проверенные выводы с уровнем риска), метрики покрытия и заявления по каждой поисковой поверхности.",
  "Проанализируй корпус целиком и составь целостную клиентскую оценку.",
  "Требования к тексту: подробный клиентский язык без жаргона; каждый риск объясняй — почему это рискованно для репутации, сделок, банковских и партнёрских проверок; к каждому риску давай конкретный совет, что с этой информацией делать.",
  "Лимиты длины (символы, жёстко): executiveConclusion ≤ 1400; digitalPortrait ≤ 1000; keyRisks.theme ≤ 160; keyRisks.explanation ≤ 700; keyRisks.advice ≤ 400; positiveSignals/recommendations item ≤ 400. Укладывайся в лимит целиком — не обрывай фразу.",
  "Строгие запреты: не выдумывай фактов, имён, компаний и событий, которых нет в переданных данных; не используй внутренние технические термины (audit, reportRunId, pipeline, dataset, provider, enum); не вставляй URL и идентификаторы; материалы других людей (тёзок) не приписывай проверяемому лицу.",
  "Пиши по-русски.",
  "Верни ТОЛЬКО JSON по схеме: {\"overallRiskLevel\": \"низкий|средний|высокий|критический\", \"executiveConclusion\": string, \"digitalPortrait\": string, \"keyRisks\": [{\"theme\": string, \"severity\": \"низкий|средний|высокий|критический\", \"explanation\": string, \"advice\": string}], \"positiveSignals\": [string], \"recommendations\": [string]}.",
].join(" ");

/**
 * Clamp at a sentence/word boundary so overlong model output still validates.
 * Prefer keeping complete sentences over hard mid-word cuts.
 */
export function clampCaseAnalysisText(text: string, max: number): string {
  const s = String(text ?? "").trim();
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const boundaries = [slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "), slice.lastIndexOf("; ")];
  const cut = Math.max(...boundaries);
  let out = cut > max * 0.45 ? slice.slice(0, cut + 1).trim() : slice.slice(0, slice.lastIndexOf(" ")).trim();
  out = out.replace(/[\s·;,]+$/u, "");
  if (!out) out = slice.trim();
  if (out.length > max) out = out.slice(0, max).trim();
  return out;
}

function clampStringList(value: unknown, max: number): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => (typeof item === "string" ? clampCaseAnalysisText(item, max) : item));
}

/**
 * Soft-coerce raw model JSON into budget before zod — length overflow must not
 * discard an otherwise valid holistic analysis (Deripaska live failure mode).
 */
export function coerceGptCaseAnalysisRaw(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (typeof o.executiveConclusion === "string") {
    o.executiveConclusion = clampCaseAnalysisText(
      o.executiveConclusion,
      GPT_CASE_ANALYSIS_BUDGETS.executiveConclusion
    );
  }
  if (typeof o.digitalPortrait === "string") {
    o.digitalPortrait = clampCaseAnalysisText(
      o.digitalPortrait,
      GPT_CASE_ANALYSIS_BUDGETS.digitalPortrait
    );
  }
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
  o.positiveSignals = clampStringList(o.positiveSignals, GPT_CASE_ANALYSIS_BUDGETS.positiveSignal);
  o.recommendations = clampStringList(o.recommendations, GPT_CASE_ANALYSIS_BUDGETS.recommendation);
  return o;
}

const INTERNAL_TOKENS =
  /\baudit\b|reportRunId|report_run|datasetId|pipeline|arsenkin|serp[-_]obs|inventoryId|schemaVersion/iu;

/** A case-analysis string is client-safe: no internal/forbidden tokens, no URLs. */
function clientSafe(text: string): boolean {
  if (!text.trim()) return false;
  if (INTERNAL_TOKENS.test(text)) return false;
  if (/https?:\/\//iu.test(text)) return false;
  return scanOrionGoldenClientTextForForbiddenTokens(text).length === 0;
}

function buildCorpusPayload(input: {
  subjectName: string;
  aliases: string[];
  contextIdentifiers: string[];
  bundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
}): Record<string, unknown> {
  return {
    subject: {
      displayName: input.subjectName,
      aliases: input.aliases,
      businessContext: input.contextIdentifiers,
    },
    metrics: {
      totalMaterials: input.metricSnapshot.compositeCount,
      subjectMatches: input.metricSnapshot.subjectMatchCount,
      ambiguous: input.metricSnapshot.ambiguousCount,
      otherSubject: input.metricSnapshot.otherSubjectCount,
      adverseFindings: input.metricSnapshot.adverseFindingCount,
      perRegion: input.metricSnapshot.perRegionCounts,
    },
    // Client-language labels only: the model echoes payload tokens, so raw
    // enums/ids here would leak into generated text and be rejected later.
    findings: input.bundle.findings.map((f) => ({
      theme: f.theme,
      claim: f.claim,
      subjectMatch: subjectMatchRu(f.subjectMatch),
      riskLevel: riskLevelRu(f.riskLevel),
      confidence: f.confidence,
      regions: f.regions,
      sourceDomains: f.sourceDomains.slice(0, 8),
      recommendedAction: f.recommendedAction,
      limitations: f.limitations.slice(0, 3),
    })),
    surfaces: input.surfaceUnits.map((u) => ({
      surface: surfaceRu(u.surface),
      region: u.region,
      engine: engineRu(u.engine),
      metrics: u.metrics.map((m) => ({ key: metricKeyRu(m.key), value: m.value })),
      claims: u.claims.slice(0, 12).map((c) => ({
        text: c.text,
        subjectMatch: subjectMatchRu(c.subjectMatch),
        riskHint: c.riskHint ? riskLevelRu(c.riskHint) : undefined,
      })),
    })),
  };
}

/**
 * Run the full-corpus GPT case analysis. Returns null on ANY failure
 * (transport, invalid JSON, unsafe strings) — callers fall back to the
 * deterministic report without blocking the pipeline.
 */
export async function runGptCaseAnalysis(input: {
  caller: GptJsonCaller;
  subjectName: string;
  aliases?: string[];
  contextIdentifiers?: string[];
  bundle: VerifiedFindingBundle;
  surfaceUnits: SurfaceAnalysisUnit[];
  metricSnapshot: MetricSnapshot;
  /** Called with a short reason whenever the analysis is discarded (fail-safe path). */
  onFailure?: (reason: string) => void;
}): Promise<GptCaseAnalysis | null> {
  const fail = (reason: string): null => {
    input.onFailure?.(reason);
    return null;
  };
  try {
    const raw = await input.caller({
      systemPrompt: CASE_ANALYSIS_SYSTEM_PROMPT,
      userPayload: buildCorpusPayload({
        subjectName: input.subjectName,
        aliases: input.aliases ?? [],
        contextIdentifiers: input.contextIdentifiers ?? [],
        bundle: input.bundle,
        surfaceUnits: input.surfaceUnits,
        metricSnapshot: input.metricSnapshot,
      }),
    });
    const coerced = coerceGptCaseAnalysisRaw(raw);
    const parsed = GptCaseAnalysisSchema.safeParse(coerced);
    if (!parsed.success) {
      return fail(`schema: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }

    // Sanitize: the conclusion must be client-safe; unsafe list entries are
    // dropped individually (fail-closed per entry, not per analysis).
    const a = parsed.data;
    if (!clientSafe(a.executiveConclusion)) return fail("unsafe executiveConclusion");
    const keyRisks = a.keyRisks.filter(
      (r) => clientSafe(r.theme) && clientSafe(r.explanation) && clientSafe(r.advice)
    );
    const recommendations = a.recommendations.filter(clientSafe);
    if (recommendations.length === 0) return fail("no client-safe recommendations");

    return {
      version: GPT_CASE_ANALYSIS_VERSION,
      generatedAt: new Date().toISOString(),
      overallRiskLevel: a.overallRiskLevel,
      executiveConclusion: a.executiveConclusion,
      digitalPortrait: a.digitalPortrait && clientSafe(a.digitalPortrait) ? a.digitalPortrait : undefined,
      keyRisks,
      positiveSignals: a.positiveSignals.filter(clientSafe),
      recommendations,
    };
  } catch (err) {
    return fail(`transport: ${err instanceof Error ? err.message : String(err)}`);
  }
}
