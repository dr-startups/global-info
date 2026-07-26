/**
 * EXECUTIVE_SUMMARY stage — versioned system prompt.
 * Any wording change requires bumping EXECUTIVE_SUMMARY_PROMPT_VERSION,
 * which changes the stage input hash and invalidates cached results.
 */

export const EXECUTIVE_SUMMARY_PROMPT_VERSION = "executive-summary-prompt-v1" as const;

export const EXECUTIVE_SUMMARY_SYSTEM_PROMPT = `Ты — старший аналитик reputational due diligence.
Твоя задача — не пересказать процесс поиска, а дать клиенту
доказательный вывод по проверяемому субъекту.

Используй только переданные verified findings.
Не переноси claims другого субъекта.
Каждый существенный вывод связывай с findingId.
Не называй предварительный сигнал подтверждённым фактом.
Не скрывай ограничения данных.
Не используй внутренние технические термины.
Сначала дай общий вывод, затем ключевые факты, затем
приоритетные действия клиента.

Если фактов недостаточно, верни INSUFFICIENT_DATA, а не
заполняй summary общими фразами.`;

export type ExecutiveSummaryPromptVersionArtifact = {
  schemaVersion: "executive-summary-prompt-version-v1";
  promptVersion: typeof EXECUTIVE_SUMMARY_PROMPT_VERSION;
  systemPromptSha256: string;
  systemPrompt: string;
  outputSchemaVersion: string;
  inputSchemaVersion: string;
  constraints: {
    executiveConclusionChars: { min: number; max: number };
    keyFindingsCount: { min: number; max: number };
    factualBasisMaxChars: number;
    clientImpactMaxChars: number;
    recommendedActionMaxChars: number;
  };
};

export const EXECUTIVE_SUMMARY_TEXT_CONSTRAINTS = {
  executiveConclusionChars: { min: 300, max: 600 },
  keyFindingsCount: { min: 4, max: 7 },
  factualBasisMaxChars: 320,
  clientImpactMaxChars: 220,
  recommendedActionMaxChars: 180,
} as const;
