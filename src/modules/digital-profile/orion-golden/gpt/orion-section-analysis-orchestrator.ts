/**
 * R10.6 — Section-by-section GPT orchestrator (one call per section).
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { OpenAiRateLimitError } from "../../orion-report-spec/openai-rate-limit";
import { callOpenAiStrictJson } from "./openai-json-client";
import { normalizeSectionAnalysis } from "./normalize-section-analysis";
import {
  buildGptRuntimeDiagnosticsArtifact,
  createAttemptDiagnostic,
  createSkippedDiagnostic,
  type GptSectionRuntimeDiagnostic,
} from "./orion-section-gpt-runtime-diagnostics";
import type { OrionSectionBundle } from "../sections/orion-section-bundle";
import type {
  OrionSectionAnalysis,
  OrionSectionAnalysisStatus,
  SectionGptOrchestrationMeta,
} from "../sections/orion-section-analysis";

const sectionAnalysisSchema = z.object({
  sectionId: z.string(),
  status: z.enum(["HAS_FINDINGS", "NO_FINDINGS", "DATA_POOR", "NOT_APPLICABLE", "MANUAL_REVIEW_PENDING"]),
  clientNarrative: z.string(),
  keyFindings: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      evidenceRefs: z.array(z.string()),
      confidence: z.enum(["Высокая", "Средняя", "Низкая"]),
      caveat: z.string().optional(),
    })
  ),
  risks: z.array(
    z.object({
      theme: z.string(),
      level: z.enum(["Низкий", "Средний", "Высокий", "Критический", "Требует проверки"]),
      summary: z.string(),
      evidenceRefs: z.array(z.string()),
      requiresManualReview: z.boolean(),
    })
  ),
  limitations: z.array(z.string()),
  recommendations: z.array(z.string()),
});

const SECTION_SYSTEM_PROMPT = `You are ORION section analyst writing CLIENT-FACING prose for one section only.

Rules:
- Write plain Russian in complete sentences. Genre: short analyst note (1 short narrative + up to 3 findings), not an evidence dump.
- Use ONLY allowedEvidence from this section — no external inventory.
- Never present MANUAL_REVIEW_ONLY or CAVEATED items as confirmed negative facts.
- Do not invent evidence. evidenceRefs must match provided evidenceId values only.
- Name concrete entities, outlets, companies, jurisdictions when present in evidence titles/snippets.
- FORBIDDEN in clientNarrative/findings: material counts, "на ручной проверке", process/gate language, incomplete caveats ending with "связано с…" / "—…".
- If data is insufficient, set status DATA_POOR and write a short limitation — no filler.
- Return ONE JSON object with keys: sectionId, status, clientNarrative, keyFindings, risks, limitations, recommendations.
- status must be one of: HAS_FINDINGS, NO_FINDINGS, DATA_POOR, NOT_APPLICABLE, MANUAL_REVIEW_PENDING.
- keyFindings items must use: title, summary, evidenceRefs (array of evidenceId strings), confidence (Высокая|Средняя|Низкая).
- risks items must use: theme, level (Низкий|Средний|Высокий|Критический|Требует проверки), summary, evidenceRefs, requiresManualReview.`;

function hashBundle(bundle: OrionSectionBundle): string {
  return createHash("sha256").update(JSON.stringify(bundle.allowedEvidence.map((e) => e.evidenceId))).digest("hex").slice(0, 16);
}

function buildDeterministicAnalysis(bundle: OrionSectionBundle): OrionSectionAnalysis {
  let status: OrionSectionAnalysisStatus = "NO_FINDINGS";
  if (!bundle.applicable) status = "NOT_APPLICABLE";
  else if (bundle.dataSufficiency === "INSUFFICIENT") status = "DATA_POOR";
  else if (bundle.sectionId === "50_manual_review_required" && bundle.allowedEvidence.length > 0) {
    status = "MANUAL_REVIEW_PENDING";
  } else if (bundle.allowedEvidence.length > 0) status = "HAS_FINDINGS";

  const narrative =
    status === "NOT_APPLICABLE"
      ? bundle.applicabilityReason
      : status === "DATA_POOR"
        ? `По секции «${bundle.title}» недостаточно подтверждённых материалов для аналитического вывода.`
        : status === "MANUAL_REVIEW_PENDING"
          ? `В секции ${bundle.allowedEvidence.length} материал(ов), требующих ручной проверки. Автоматически подтверждённые негативные выводы не формируются.`
          : bundle.sectionId === "51_excluded_noise_summary"
            ? `Исключено ${bundle.excludedEvidenceSummary.length} шумовых материалов из клиентского отчёта.`
            : bundle.sectionId === "52_limitations"
              ? "Проверка ограничена доступными открытыми источниками и политикой фильтрации доказательств."
              : bundle.sectionId === "00_case_identity"
                ? `Субъект проверки идентифицирован для целей предварительного аудита.`
                : `Секция сформирована детерминированно без GPT-вызова.`;

  return {
    version: "r10-6-orion-section-analysis-v1",
    sectionId: bundle.sectionId,
    order: bundle.order,
    title: bundle.title,
    status,
    clientNarrative: narrative,
    keyFindings: bundle.allowedEvidence.slice(0, 10).map((e) => ({
      title: e.title.slice(0, 120),
      summary: e.clientUse === "MANUAL_REVIEW_ONLY" ? `[Требует проверки] ${e.title}` : e.title,
      evidenceRefs: [e.evidenceId],
      confidence: e.clientUse === "MAIN_ANALYSIS" ? "Средняя" : "Низкая",
      caveat: e.caveat,
    })),
    risks: [],
    limitations: bundle.sectionWarnings,
    recommendations: [],
    sourceSectionBundleHash: hashBundle(bundle),
    generatedBy: "deterministic",
    gptCallMade: false,
  };
}

async function analyzeOneSectionGpt(
  bundle: OrionSectionBundle,
  caseInfo: { subjectName: string; caseId: string }
): Promise<OrionSectionAnalysis> {
  const userPayload = {
    caseInfo: { subjectName: caseInfo.subjectName, caseId: caseInfo.caseId },
    sectionId: bundle.sectionId,
    sectionTitle: bundle.title,
    sectionPurpose: bundle.sectionPurpose,
    allowedEvidence: bundle.allowedEvidence.slice(0, 25),
    manualReviewSummary: bundle.manualReviewSummary,
    dataSufficiency: bundle.dataSufficiency,
    sectionWarnings: bundle.sectionWarnings,
  };

  const raw = await callOpenAiStrictJson({ systemPrompt: SECTION_SYSTEM_PROMPT, userPayload });
  const normalized = normalizeSectionAnalysis(
    (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>,
    bundle.sectionId
  );
  const parsed = sectionAnalysisSchema.parse(normalized);
  const keyFindings =
    parsed.status === "MANUAL_REVIEW_PENDING"
      ? parsed.keyFindings.map((f) => ({
          ...f,
          caveat: f.caveat ?? "Требует ручной проверки",
          summary: f.summary.includes("Требует") ? f.summary : `[Требует проверки] ${f.summary}`,
        }))
      : parsed.keyFindings;
  const risks =
    parsed.status === "MANUAL_REVIEW_PENDING"
      ? parsed.risks.map((r) => ({ ...r, requiresManualReview: true }))
      : parsed.risks;

  return {
    version: "r10-6-orion-section-analysis-v1",
    sectionId: bundle.sectionId,
    order: bundle.order,
    title: bundle.title,
    status: parsed.status,
    clientNarrative: parsed.clientNarrative,
    keyFindings,
    risks,
    limitations: parsed.limitations,
    recommendations: parsed.recommendations,
    sourceSectionBundleHash: hashBundle(bundle),
    generatedBy: "gpt-5.5",
    gptCallMade: true,
  };
}

export async function analyzeOrionSections(input: {
  sectionBundles: OrionSectionBundle[];
  caseInfo: { subjectName: string; caseId: string };
  requireAi: boolean;
}): Promise<{
  analyses: OrionSectionAnalysis[];
  meta: SectionGptOrchestrationMeta;
  runtimeDiagnostics: ReturnType<typeof buildGptRuntimeDiagnosticsArtifact>;
}> {
  if (!input.requireAi) throw new Error("gpt55-required");

  const analyses: OrionSectionAnalysis[] = [];
  const diagnostics: GptSectionRuntimeDiagnostic[] = [];
  const meta: SectionGptOrchestrationMeta = {
    gptSectionCallCount: 0,
    gptSectionCallIds: [],
    skippedSections: [],
    executiveSynthesisCallCount: 0,
    riskMatrixSynthesisCount: 0,
    megaPromptUsed: false,
  };

  for (const bundle of input.sectionBundles) {
    if (bundle.analysisMode !== "GPT_SECTION_ANALYSIS") {
      analyses.push(buildDeterministicAnalysis(bundle));
      meta.skippedSections.push({ sectionId: bundle.sectionId, reason: `analysisMode=${bundle.analysisMode}` });
      diagnostics.push(createSkippedDiagnostic(bundle, `analysisMode=${bundle.analysisMode}`));
      continue;
    }

    if (!bundle.applicable) {
      analyses.push(buildDeterministicAnalysis(bundle));
      meta.skippedSections.push({ sectionId: bundle.sectionId, reason: "not_applicable" });
      diagnostics.push(createSkippedDiagnostic(bundle, "not_applicable"));
      continue;
    }

    if (bundle.dataSufficiency === "INSUFFICIENT" && bundle.allowedEvidence.length === 0) {
      analyses.push(buildDeterministicAnalysis(bundle));
      meta.skippedSections.push({ sectionId: bundle.sectionId, reason: "data_insufficient_no_gpt" });
      diagnostics.push(createSkippedDiagnostic(bundle, "data_insufficient_no_gpt"));
      continue;
    }

    try {
      const analysis = await analyzeOneSectionGpt(bundle, input.caseInfo);
      analyses.push(analysis);
      meta.gptSectionCallCount += 1;
      meta.gptSectionCallIds.push(bundle.sectionId);
      diagnostics.push(
        createAttemptDiagnostic({ bundle, caseInfo: input.caseInfo, success: true, analysis })
      );
    } catch (err) {
      if (err instanceof OpenAiRateLimitError) throw err;
      analyses.push({
        ...buildDeterministicAnalysis(bundle),
        status: "DATA_POOR",
        limitations: [...bundle.sectionWarnings, "GPT-анализ секции временно недоступен."],
      });
      meta.skippedSections.push({ sectionId: bundle.sectionId, reason: "gpt_failed_fallback" });
      diagnostics.push(
        createAttemptDiagnostic({ bundle, caseInfo: input.caseInfo, success: false, err })
      );
    }
  }

  return {
    analyses,
    meta,
    runtimeDiagnostics: buildGptRuntimeDiagnosticsArtifact({ diagnostics }),
  };
}

export { hashBundle as hashSectionBundle };
