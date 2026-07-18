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

export const GPT_CASE_ANALYSIS_VERSION = "gpt-case-analysis-v1" as const;

/** Strict JSON caller (system prompt + payload → parsed JSON). */
export type GptJsonCaller = (input: {
  systemPrompt: string;
  userPayload: unknown;
}) => Promise<unknown>;

const RiskWordSchema = z.enum(["низкий", "средний", "высокий", "критический"]);

const KeyRiskSchema = z.object({
  theme: z.string().min(1).max(160),
  severity: RiskWordSchema,
  /** Client-language explanation of WHY this is risky for the subject. */
  explanation: z.string().min(1).max(700),
  /** What the client should do about it. */
  advice: z.string().min(1).max(400),
});

export const GptCaseAnalysisSchema = z.object({
  overallRiskLevel: RiskWordSchema,
  /** 2–5 sentence executive conclusion in client language. */
  executiveConclusion: z.string().min(1).max(1400),
  /** How the subject currently looks to someone who searches for them. */
  digitalPortrait: z.string().max(1000).optional(),
  keyRisks: z.array(KeyRiskSchema).max(10),
  positiveSignals: z.array(z.string().min(1).max(400)).max(10).default([]),
  recommendations: z.array(z.string().min(1).max(400)).min(1).max(10),
});

export type GptCaseAnalysis = z.infer<typeof GptCaseAnalysisSchema> & {
  version: typeof GPT_CASE_ANALYSIS_VERSION;
  generatedAt: string;
};

export const GPT_CASE_ANALYSIS_PROMPT_VERSION = "gpt-case-analysis-prompt-v1";

const CASE_ANALYSIS_SYSTEM_PROMPT = [
  "Ты — старший аналитик reputational due diligence, готовящий клиентский отчёт о цифровом профиле проверяемого лица.",
  "Тебе передан ПОЛНЫЙ верифицированный аналитический корпус: все findings (проверенные выводы с уровнем риска), метрики покрытия и заявления по каждой поисковой поверхности.",
  "Проанализируй корпус целиком и составь целостную клиентскую оценку.",
  "Требования к тексту: подробный клиентский язык без жаргона; каждый риск объясняй — почему это рискованно для репутации, сделок, банковских и партнёрских проверок; к каждому риску давай конкретный совет, что с этой информацией делать.",
  "Строгие запреты: не выдумывай фактов, имён, компаний и событий, которых нет в переданных данных; не используй внутренние технические термины (audit, reportRunId, pipeline, dataset, provider, enum); не вставляй URL и идентификаторы; материалы других людей (тёзок) не приписывай проверяемому лицу.",
  "Пиши по-русски.",
  "Верни ТОЛЬКО JSON по схеме: {\"overallRiskLevel\": \"низкий|средний|высокий|критический\", \"executiveConclusion\": string, \"digitalPortrait\": string, \"keyRisks\": [{\"theme\": string, \"severity\": \"низкий|средний|высокий|критический\", \"explanation\": string, \"advice\": string}], \"positiveSignals\": [string], \"recommendations\": [string]}.",
].join(" ");

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
    findings: input.bundle.findings.map((f) => ({
      findingId: f.findingId,
      theme: f.theme,
      claim: f.claim,
      subjectMatch: f.subjectMatch,
      riskLevel: f.riskLevel,
      confidence: f.confidence,
      regions: f.regions,
      sourceDomains: f.sourceDomains.slice(0, 8),
      recommendedAction: f.recommendedAction,
      limitations: f.limitations.slice(0, 3),
    })),
    surfaces: input.surfaceUnits.map((u) => ({
      surface: u.surface,
      region: u.region,
      engine: u.engine,
      metrics: u.metrics.map((m) => ({ key: m.key, value: m.value })),
      claims: u.claims.slice(0, 12).map((c) => ({
        text: c.text,
        subjectMatch: c.subjectMatch,
        riskHint: c.riskHint,
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
}): Promise<GptCaseAnalysis | null> {
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
    const parsed = GptCaseAnalysisSchema.safeParse(raw);
    if (!parsed.success) return null;

    // Sanitize: the conclusion must be client-safe; unsafe list entries are
    // dropped individually (fail-closed per entry, not per analysis).
    const a = parsed.data;
    if (!clientSafe(a.executiveConclusion)) return null;
    const keyRisks = a.keyRisks.filter(
      (r) => clientSafe(r.theme) && clientSafe(r.explanation) && clientSafe(r.advice)
    );
    const recommendations = a.recommendations.filter(clientSafe);
    if (recommendations.length === 0) return null;

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
  } catch {
    return null;
  }
}
