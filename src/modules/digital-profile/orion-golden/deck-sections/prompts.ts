/**
 * Independent, versioned LLM prompts — one prompt per surface fragment.
 *
 * A single "generate the whole presentation" prompt is forbidden. Each prompt:
 * - versioned (promptVersion participates in the cache key);
 * - schema constrained (LLM returns only the SlideBody content contract);
 * - evidence grounded (only scoped findings/claims are passed);
 * - independently retryable and cacheable (inputHash + promptVersion).
 *
 * The model never receives: element coordinates, textbox sizes, global page
 * numbers, or content of unrelated sections.
 */

import type { FragmentKey } from "./contracts";

export type FragmentPromptDef = {
  promptKey: string;
  promptVersion: string;
  /** True when the fragment is deterministic (no LLM copywriting needed). */
  deterministic: boolean;
  systemPrompt: string;
};

const ANALYST_BASE = [
  "Ты — старший аналитик reputational due diligence.",
  "Используй только переданные scoped findings и claims; не добавляй фактов.",
  "Каждый существенный тезис связывай с findingId.",
  "Не используй внутренние технические термины (audit, reportRunId, pipeline, dataset).",
  "Не называй материалы другого субъекта нейтральными данными проверяемого лица.",
  "Верни только JSON по схеме SlideBody (narrative, bullets, whatWasFound, whyItMatters, whatToCheck, sourceNote).",
].join(" ");

function llmPrompt(promptKey: string, topic: string): FragmentPromptDef {
  return {
    promptKey,
    promptVersion: `${promptKey}-v1`,
    deterministic: false,
    systemPrompt: `${ANALYST_BASE} Тема фрагмента: ${topic}.`,
  };
}

function deterministicPrompt(promptKey: string): FragmentPromptDef {
  return {
    promptKey,
    promptVersion: `${promptKey}-deterministic-v1`,
    deterministic: true,
    systemPrompt: "",
  };
}

export const FRAGMENT_PROMPTS: Record<FragmentKey, FragmentPromptDef> = {
  FRONT_MATTER_MAIN: deterministicPrompt("front-matter"),
  // v2: §7.3 sparse structure — coverage / LIKELY / namesake / recommendations.
  EXECUTIVE_SUMMARY: {
    ...llmPrompt(
      "executive-summary",
      "итоговое резюме по проверяемому лицу на основе VerifiedFindingBundle"
    ),
    promptVersion: "executive-summary-v2",
  },
  // v2: reserve first-page slot for LIKELY «Требует подтверждения» (§2.1).
  RISK_MATRIX: {
    ...deterministicPrompt("risk-matrix"),
    promptVersion: "risk-matrix-deterministic-v2",
  },
  DIGITAL_PROFILE_OVERVIEW: deterministicPrompt("digital-profile-overview"),
  RU_SUMMARY: llmPrompt("ru-regional-summary", "региональный обзор RU-поверхностей"),
  // v2: §7.1 page composition mirrored into narrative (above-table copy).
  RU_SERP: {
    ...llmPrompt("ru-serp-analysis", "анализ органической выдачи RU"),
    promptVersion: "ru-serp-analysis-v2",
  },
  RU_SERP_SCREENSHOT: llmPrompt("ru-serp-screenshot-analysis", "анализ скриншота выдачи RU"),
  RU_SUGGESTIONS: llmPrompt("ru-suggestions-analysis", "анализ поисковых подсказок RU"),
  RU_IMAGES: llmPrompt("ru-images-analysis", "анализ изображений в выдаче RU"),
  RU_IDENTITY_WIKIPEDIA: llmPrompt("ru-identity-analysis", "идентификация субъекта в Википедии/панелях знаний RU"),
  RU_KNOWLEDGE_AI: llmPrompt("ru-ai-analysis", "анализ AI-ответов поисковых систем RU"),
  RU_RELATED: llmPrompt("ru-related-analysis", "анализ связанных запросов RU"),
  UAE_SUMMARY: llmPrompt("uae-regional-summary", "региональный обзор UAE-поверхностей"),
  // v2: §7.1 page composition mirrored into narrative (above-table copy).
  UAE_SERP: {
    ...llmPrompt("uae-serp-analysis", "анализ органической выдачи UAE"),
    promptVersion: "uae-serp-analysis-v2",
  },
  UAE_SERP_SCREENSHOT: llmPrompt("uae-serp-screenshot-analysis", "анализ скриншота выдачи UAE"),
  UAE_SUGGESTIONS: llmPrompt("uae-suggestions-analysis", "анализ поисковых подсказок UAE"),
  UAE_IMAGES: llmPrompt("uae-images-analysis", "анализ изображений в выдаче UAE"),
  UAE_IDENTITY_WIKIPEDIA: llmPrompt("uae-identity-analysis", "идентификация субъекта в Википедии/панелях знаний UAE"),
  UAE_KNOWLEDGE_AI: llmPrompt("uae-ai-analysis", "анализ AI-ответов поисковых систем UAE"),
  UAE_RELATED: llmPrompt("uae-related-analysis", "анализ связанных запросов UAE"),
  COMPLIANCE_MAIN: deterministicPrompt("compliance-existing-content"),
  APPENDIX_MAIN: deterministicPrompt("appendix"),
};

export function getFragmentPrompt(key: FragmentKey): FragmentPromptDef {
  return FRAGMENT_PROMPTS[key];
}
