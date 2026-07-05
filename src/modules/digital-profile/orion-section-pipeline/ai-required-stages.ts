/**
 * R9.5c — micro-stages that MUST be produced by GPT-5.5 analysis for a
 * user-facing ORION v2 client report. Static/commercial stages (cover, offer,
 * about, pricing, etc.) may remain deterministic and are intentionally omitted.
 *
 * When AI is required and a stage in this list is not `generatedBy="gpt-5.5"`,
 * the pipeline treats the run as blocking unless deterministic fallback is
 * explicitly allowed for dev/test.
 */
export const ORION_V2_GPT_REQUIRED_MICRO_STAGES: readonly string[] = [
  "executive_narrative_summary",
  "compliance_risk_matrix",
  "digital_profile_risk_overview",

  "ru_audit_summary",
  "ru_search_links_overview",
  "ru_top20_serp_matrix",
  "ru_adverse_themes_serp_examples",
  "ru_yandex_suggestions",
  "ru_google_suggestions",
  "ru_wikipedia",
  "ru_yandex_images",
  "ru_google_images",
  "ru_yandex_knowledge_panel",
  "ru_google_knowledge_panel",
  "ru_yandex_related_queries",
  "ru_google_related_queries",

  "uae_audit_summary",
  "uae_google_search_links_overview",
  "uae_google_top20_serp_matrix",
  "uae_adverse_themes_serp_examples",
  "uae_google_suggestions",
  "uae_wikipedia",
  "uae_google_images",
  "uae_google_knowledge_panel",
  "uae_google_related_queries",

  "lexisnexis_profile_overview",
  "compliance_database_summary_for_risk_matrix",
];

export const ORION_V2_GPT_REQUIRED_MICRO_STAGE_SET: ReadonlySet<string> = new Set(
  ORION_V2_GPT_REQUIRED_MICRO_STAGES
);

/** True when the given micro-stage must be GPT-5.5-backed in user-facing runs. */
export function isAiRequiredMicroStage(microStageKey: string): boolean {
  return ORION_V2_GPT_REQUIRED_MICRO_STAGE_SET.has(microStageKey);
}
