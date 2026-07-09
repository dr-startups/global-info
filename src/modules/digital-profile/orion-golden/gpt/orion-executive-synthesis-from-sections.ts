/**
 * R10.6 / R10.11 — Executive synthesis from section analyses only (no raw inventory).
 * Client genre: ORION-style analyst résumé (scope → themes → sources → DB hits → next step).
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

const EXEC_SYSTEM = `You write the CLIENT-FACING executive résumé for an ORION-style digital profile audit.

Genre (match a human compliance analyst, NOT a system log):
1) Scope — what was checked (open-web TOP results RU/UAE, Wikipedia, LexisNexis / Dow Jones / World-Check if present in sections).
2) Search themes WITH named entities, companies, jurisdictions (sanctions/PEP, criminal/legal, business disputes, reputation, family/associates) — only if supported by section findings.
3) Specific publications / outlets / registry hits when sections name them.
4) Compliance DB signals (e.g. Dow Jones RCA, LexisNexis PEP) — preliminary only; never invent hits.
5) One clear next step for the client.

Hard rules:
- Plain Russian. Complete sentences only. No mid-thought endings ("связано с…", "—…", "это может быть связано с:" without continuation).
- FORBIDDEN in executiveSummary and bullets: material counts ("N материалов"), "на ручной проверке", "artifact-backed", "секций проанализировано", queue/gate/judgment process language, raw IDs, storage paths, enum keys.
- Do NOT dump URL lists or evidence titles. Evidence informs the narrative; the résumé is synthesis.
- Do NOT present MANUAL_REVIEW_PENDING / caveated items as confirmed facts.
- Prefer concrete names and themes over generic "выявлены риски".
- executiveSummary: 2–4 short paragraphs (use \\n\\n between paragraphs), ~900–1400 characters total, self-contained on one slide.
- mainRisks: 4–7 thematic bullets (theme + who/what + why it matters), each one complete sentence ≤180 chars.
- possibleConsequences: 0–3 concrete compliance/reputation consequences (or empty if unknown).
- finalRecommendations / nextSteps: actionable, specific, no process meta.

Return ONE JSON object:
executiveSummary, globalRiskLevel, mainRisks, possibleConsequences, finalRecommendations, nextSteps.
globalRiskLevel must be one of: Низкий, Средний, Высокий, Критический, Требует проверки.`;

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

function pickFindingLines(synthesisInput: ExecutiveSynthesisInput, limit: number): string[] {
  const lines: string[] = [];
  for (const section of synthesisInput.sectionSummaries) {
    if (section.status !== "HAS_FINDINGS") continue;
    for (const finding of section.keyFindings) {
      const summary = String(finding.summary ?? "").trim();
      const title = String(finding.title ?? "").trim();
      if (!summary && !title) continue;
      if (/ручной проверк|материал\(ов\)|artifact-backed/i.test(`${title} ${summary}`)) continue;
      const line = summary.length >= title.length ? summary : `${title}: ${summary}`;
      if (line.length < 24) continue;
      lines.push(line);
      if (lines.length >= limit) return lines;
    }
    for (const risk of section.risks) {
      if (risk.requiresManualReview) continue;
      const line = String(risk.summary ?? "").trim();
      if (line.length < 24) continue;
      lines.push(line);
      if (lines.length >= limit) return lines;
    }
  }
  return lines;
}

export function buildDeterministicExecutiveFallback(
  synthesisInput: ExecutiveSynthesisInput
): ExecutiveSynthesisOutput {
  const themes = pickFindingLines(synthesisInput, 6);
  const subject = synthesisInput.subjectName;
  const paragraphs = [
    `По субъекту «${subject}» выполнен предварительный аудит открытого цифрового профиля: поисковая выдача, связанные поверхности и доступные комплаенс-сводки по секциям.`,
    themes.length > 0
      ? `В материалах секций выделяются следующие линии риска и репутационного контекста:\n${themes
          .slice(0, 4)
          .map((t) => `— ${t}`)
          .join("\n")}`
      : `На текущем этапе подтверждённые дифференцирующие сигналы ограничены; выводы носят предварительный характер и требуют сверки с первоисточниками.`,
    `Следующий шаг — точечная верификация ключевых публикаций и комплаенс-хитов перед финальным заключением.`,
  ];

  return {
    version: "r10-6-executive-synthesis-output-v1",
    executiveSummary: paragraphs.join("\n\n"),
    globalRiskLevel: themes.length >= 4 ? "Высокий" : themes.length > 0 ? "Средний" : "Требует проверки",
    mainRisks: themes.slice(0, 6),
    possibleConsequences:
      themes.length > 0
        ? ["Повышенная нагрузка на KYC/AML и репутационную проверку контрагента до подтверждения первоисточников."]
        : [],
    finalRecommendations:
      themes.length > 0
        ? [
            "Сверить названные публикации и реестровые якоря с первоисточниками.",
            "Зафиксировать статус PEP/санкционных сигналов только после подтверждённого хита в комплаенс-базе.",
          ]
        : ["Дособрать подтверждённые источники по ключевым темам до финального резюме."],
    nextSteps: ["Подготовить короткий бриф для клиента с 3–5 проверяемыми якорями и одним рекомендуемым действием."],
    generatedBy: "deterministic",
  };
}
