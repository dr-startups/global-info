/**
 * R10.6 — Executive synthesis from section analyses only (no raw inventory).
 */

import { z } from "zod";
import { callOpenAiStrictJson } from "./openai-json-client";
import type { OrionSectionAnalysis } from "../sections/orion-section-analysis";

export type ExecutiveSynthesisInput = {
  version: "r10-6-executive-synthesis-input-v1";
  caseId: string;
  subjectName: string;
  sectionSummaries: Array<{
    sectionId: string;
    title: string;
    status: string;
    clientNarrative: string;
    keyFindings: Array<{ title: string; summary: string; evidenceRefs: string[]; caveat?: string }>;
    risks: Array<{ theme: string; level: string; summary: string; evidenceRefs: string[]; requiresManualReview: boolean }>;
    limitations: string[];
    recommendations: string[];
  }>;
};

export type ExecutiveSynthesisOutput = {
  version: "r10-6-executive-synthesis-output-v1";
  executiveSummary: string;
  globalRiskLevel: "Низкий" | "Средний" | "Высокий" | "Критический" | "Требует проверки";
  mainRisks: string[];
  possibleConsequences: string[];
  finalRecommendations: string[];
  nextSteps: string[];
  generatedBy: "gpt-5.5" | "deterministic";
};

const execSchema = z.object({
  executiveSummary: z.string(),
  globalRiskLevel: z.enum(["Низкий", "Средний", "Высокий", "Критический", "Требует проверки"]),
  mainRisks: z.array(z.string()),
  possibleConsequences: z.array(z.string()),
  finalRecommendations: z.array(z.string()),
  nextSteps: z.array(z.string()),
});

const EXEC_SYSTEM = `Synthesize ORION executive summary from SECTION ANALYSES ONLY.

Forbidden: raw inventory, raw search results, excluded noise, wrong-subject items, pending manual-review as confirmed risk.
Write plain Russian. Preliminary compliance framing only.
Return ONE JSON: executiveSummary, globalRiskLevel, mainRisks, possibleConsequences, finalRecommendations, nextSteps.`;

export function buildExecutiveSynthesisInput(
  caseId: string,
  subjectName: string,
  sectionAnalyses: OrionSectionAnalysis[]
): ExecutiveSynthesisInput {
  return {
    version: "r10-6-executive-synthesis-input-v1",
    caseId,
    subjectName,
    sectionSummaries: sectionAnalyses
      .filter((s) => s.sectionId !== "01_executive_summary" && s.sectionId !== "02_compliance_risk_matrix")
      .map((s) => ({
        sectionId: s.sectionId,
        title: s.title,
        status: s.status,
        clientNarrative: s.clientNarrative,
        keyFindings: s.keyFindings,
        risks: s.risks,
        limitations: s.limitations,
        recommendations: s.recommendations,
      })),
  };
}

function normalizeExecutiveSynthesis(raw: Record<string, unknown>): Record<string, unknown> {
  const levelMap: Record<string, ExecutiveSynthesisOutput["globalRiskLevel"]> = {
    low: "Низкий",
    medium: "Средний",
    high: "Высокий",
    critical: "Критический",
    review_required: "Требует проверки",
    низкий: "Низкий",
    средний: "Средний",
    высокий: "Высокий",
    критический: "Критический",
  };
  const asArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
  };
  const levelRaw = String(raw.globalRiskLevel ?? raw.riskLevel ?? "Требует проверки").trim();
  const mappedLevel =
    levelMap[levelRaw.toLowerCase()] ??
    (["Низкий", "Средний", "Высокий", "Критический", "Требует проверки"].includes(levelRaw)
      ? (levelRaw as ExecutiveSynthesisOutput["globalRiskLevel"])
      : "Требует проверки");

  return {
    executiveSummary: String(raw.executiveSummary ?? raw.summary ?? ""),
    globalRiskLevel: mappedLevel,
    mainRisks: asArray(raw.mainRisks ?? raw.risks),
    possibleConsequences: asArray(raw.possibleConsequences ?? raw.consequences),
    finalRecommendations: asArray(raw.finalRecommendations ?? raw.recommendations),
    nextSteps: asArray(raw.nextSteps ?? raw.steps),
  };
}

export async function buildExecutiveSynthesisFromSections(input: {
  synthesisInput: ExecutiveSynthesisInput;
  requireAi: boolean;
}): Promise<ExecutiveSynthesisOutput> {
  if (!input.requireAi) throw new Error("gpt55-required");

  const raw = await callOpenAiStrictJson({ systemPrompt: EXEC_SYSTEM, userPayload: input.synthesisInput });
  const normalized = normalizeExecutiveSynthesis(
    (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  );
  const parsed = execSchema.parse(normalized);
  return {
    version: "r10-6-executive-synthesis-output-v1",
    ...parsed,
    generatedBy: "gpt-5.5",
  };
}

export function buildDeterministicExecutiveFallback(
  synthesisInput: ExecutiveSynthesisInput
): ExecutiveSynthesisOutput {
  const withFindings = synthesisInput.sectionSummaries.filter((s) => s.status === "HAS_FINDINGS").length;
  const pending = synthesisInput.sectionSummaries.filter((s) => s.status === "MANUAL_REVIEW_PENDING").length;
  return {
    version: "r10-6-executive-synthesis-output-v1",
    executiveSummary: `Предварительная сводка по субъекту «${synthesisInput.subjectName}». Проанализировано ${synthesisInput.sectionSummaries.length} секций, из них с выводами: ${withFindings}. Материалы на ручной проверке: ${pending}.`,
    globalRiskLevel: pending > 5 ? "Требует проверки" : "Средний",
    mainRisks: synthesisInput.sectionSummaries.flatMap((s) => s.risks.map((r) => r.summary)).slice(0, 5),
    possibleConsequences: ["Требуется верификация первоисточников перед окончательными compliance-выводами."],
    finalRecommendations: synthesisInput.sectionSummaries.flatMap((s) => s.recommendations).slice(0, 5),
    nextSteps: pending > 0 ? ["Завершить ручную проверку материалов из очереди."] : ["Подтвердить ключевые выводы по первоисточникам."],
    generatedBy: "deterministic",
  };
}
