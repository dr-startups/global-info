/**

 * R10.6a — Safe GPT section runtime diagnostics (no secrets/raw prompts).

 */



import { digitalProfileConfig } from "../../config";

import type { OrionSectionBundle } from "../sections/orion-section-bundle";

import type { OrionSectionAnalysis } from "../sections/orion-section-analysis";



export type GptSectionRuntimeDiagnostic = {

  sectionId: string;

  sectionTitle: string;

  analysisMode: string;

  allowedEvidenceCount: number;

  dataSufficiency: string;

  attempted: boolean;

  success: boolean;

  fallbackUsed: boolean;

  errorType?: string;

  sanitizedErrorMessage?: string;

  responseValidationErrors?: Array<{ path: string; message: string }>;

  modelUsed?: string;

  promptInputShapeSummary: {

    hasCaseInfo: boolean;

    hasSectionId: boolean;

    hasAllowedEvidence: boolean;

    allowedEvidenceCount: number;

    containsFullInventory: boolean;

    containsExcludedNoise: boolean;

    containsWrongSubject: boolean;

  };

};



export type GptSectionRuntimeDiagnosticsArtifact = {

  version: "r10-6-gpt-runtime-diagnostics-v1";

  generatedAt: string;

  modelConfigured: string;

  aiEnabled: boolean;

  totalAttempts: number;

  successfulCalls: number;

  failedCalls: number;

  fallbackCount: number;

  sections: GptSectionRuntimeDiagnostic[];

};



function sanitizeErrorMessage(message: string): string {

  return message

    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED_KEY]")

    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")

    .slice(0, 500);

}



function classifyError(err: unknown): { errorType: string; sanitizedErrorMessage: string } {

  if (err && typeof err === "object" && "issues" in err && Array.isArray((err as { issues: unknown }).issues)) {

    const zodErr = err as { issues: Array<{ path: (string | number)[]; message: string }> };

    const first = zodErr.issues[0];

    return {

      errorType: "ZodValidationError",

      sanitizedErrorMessage: sanitizeErrorMessage(

        first ? `${first.path.join(".")}: ${first.message}` : "Zod validation failed"

      ),

    };

  }

  if (err instanceof SyntaxError) {

    return { errorType: "JSONParseError", sanitizedErrorMessage: sanitizeErrorMessage(err.message) };

  }

  if (err instanceof Error) {

    if (err.message.includes("openai-http-")) return { errorType: "APIClientError", sanitizedErrorMessage: err.message };

    if (err.message.includes("openai-empty-response")) return { errorType: "EmptyResponse", sanitizedErrorMessage: err.message };

    if (err.message.includes("gpt55-required")) return { errorType: "GptUnavailable", sanitizedErrorMessage: err.message };

    if (err.message.includes("abort")) return { errorType: "Timeout", sanitizedErrorMessage: "Request timed out" };

    return { errorType: err.constructor.name, sanitizedErrorMessage: sanitizeErrorMessage(err.message) };

  }

  return { errorType: "UnknownError", sanitizedErrorMessage: "Unknown GPT runtime error" };

}



function extractZodIssues(err: unknown): Array<{ path: string; message: string }> | undefined {

  if (err && typeof err === "object" && "issues" in err && Array.isArray((err as { issues: unknown }).issues)) {

    return (err as { issues: Array<{ path: (string | number)[]; message: string }> }).issues

      .slice(0, 10)

      .map((i) => ({ path: i.path.join("."), message: i.message }));

  }

  return undefined;

}



export function buildPromptInputShapeSummary(

  bundle: OrionSectionBundle,

  caseInfo?: { subjectName: string; caseId: string }

): GptSectionRuntimeDiagnostic["promptInputShapeSummary"] {

  const payload = {

    caseInfo,

    sectionId: bundle.sectionId,

    allowedEvidence: bundle.allowedEvidence,

  };

  const serialized = JSON.stringify(payload);

  return {

    hasCaseInfo: Boolean(caseInfo?.caseId && caseInfo?.subjectName),

    hasSectionId: Boolean(bundle.sectionId),

    hasAllowedEvidence: bundle.allowedEvidence.length > 0,

    allowedEvidenceCount: bundle.allowedEvidence.length,

    containsFullInventory: serialized.includes("full-evidence-inventory") || serialized.includes('"items":'),

    containsExcludedNoise: bundle.allowedEvidence.some((e) => e.reviewDecision === "EXCLUDE_NOISE"),

    containsWrongSubject: bundle.allowedEvidence.some(

      (e) => e.reviewDecision === "EXCLUDE_WRONG_SUBJECT" || e.subjectBinding === "WRONG_SUBJECT"

    ),

  };

}



export function buildGptRuntimeDiagnosticsArtifact(input: {

  diagnostics: GptSectionRuntimeDiagnostic[];

}): GptSectionRuntimeDiagnosticsArtifact {

  const attempted = input.diagnostics.filter((d) => d.attempted);

  return {

    version: "r10-6-gpt-runtime-diagnostics-v1",

    generatedAt: new Date().toISOString(),

    modelConfigured: digitalProfileConfig.aiAnalyst.model,

    aiEnabled: digitalProfileConfig.aiAnalyst.enabled,

    totalAttempts: attempted.length,

    successfulCalls: attempted.filter((d) => d.success).length,

    failedCalls: attempted.filter((d) => d.attempted && !d.success).length,

    fallbackCount: input.diagnostics.filter((d) => d.fallbackUsed).length,

    sections: input.diagnostics,

  };

}



export function createSkippedDiagnostic(

  bundle: OrionSectionBundle,

  reason: string

): GptSectionRuntimeDiagnostic {

  return {

    sectionId: bundle.sectionId,

    sectionTitle: bundle.title,

    analysisMode: bundle.analysisMode,

    allowedEvidenceCount: bundle.allowedEvidence.length,

    dataSufficiency: bundle.dataSufficiency,

    attempted: false,

    success: false,

    fallbackUsed: reason === "gpt_failed_fallback",

    errorType: reason === "gpt_failed_fallback" ? "GptFailedFallback" : undefined,

    sanitizedErrorMessage: reason !== "gpt_failed_fallback" ? reason : undefined,

    promptInputShapeSummary: buildPromptInputShapeSummary(bundle),

  };

}



export function createAttemptDiagnostic(input: {

  bundle: OrionSectionBundle;

  caseInfo: { subjectName: string; caseId: string };

  success: boolean;

  analysis?: OrionSectionAnalysis;

  err?: unknown;

}): GptSectionRuntimeDiagnostic {

  const { errorType, sanitizedErrorMessage } = input.err

    ? classifyError(input.err)

    : { errorType: undefined, sanitizedErrorMessage: undefined };



  return {

    sectionId: input.bundle.sectionId,

    sectionTitle: input.bundle.title,

    analysisMode: input.bundle.analysisMode,

    allowedEvidenceCount: input.bundle.allowedEvidence.length,

    dataSufficiency: input.bundle.dataSufficiency,

    attempted: true,

    success: input.success,

    fallbackUsed: !input.success,

    errorType: input.success ? undefined : errorType,

    sanitizedErrorMessage: input.success ? undefined : sanitizedErrorMessage,

    responseValidationErrors: input.err ? extractZodIssues(input.err) : undefined,

    modelUsed: input.success ? digitalProfileConfig.aiAnalyst.model : undefined,

    promptInputShapeSummary: buildPromptInputShapeSummary(input.bundle, input.caseInfo),

  };

}


