/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

export type {
  ExecutiveSummaryExtras,
  GptCaseAnalysisExtras,
  UncategorizedMaterialsExtras,
  FragmentExtras,
  FragmentBuildOutput,
  PageEvidenceView,
  PageRowComposition,
} from "./shared";
export {
  matchGptKeyRisk,
  VISUAL_ASSET_UNAVAILABLE,
  fitClientSentences,
  splitClientParagraphs,
  clampClientText,
  composePageRowComposition,
  pageRowCompositionBlocks,
  coverageContent,
  sourceLine,
  localizedThemedClaim,
  statusLine,
  structureThemeClaimText,
  reflowThemeBullet,
  reflowNarrativeParagraphs,
  claimBodyWithoutTheme,
  themedClaim,
  withContinuations,
} from "./shared";

export { buildFrontMatterFragment } from "./front-matter";

export type { ExecutivePageStructure } from "./executive";
export {
  executiveFreshnessChangeVisibleLine,
  ensureExecutiveFreshnessChangeInNarrative,
  applyExecutiveFreshnessChangeToPacks,
  composeExecutivePageStructure,
  RISK_MATRIX_LIKELY_AGGREGATE_ID,
  packRiskMatrixPages,
  buildExecutiveSummaryFragment,
  buildExecutiveSummaryFromComposed,
  buildRiskMatrixFragment,
  buildDigitalProfileOverviewFragment,
} from "./executive";

export {
  paginateComposedClientSummary,
  assertSemanticSummaryGatesPass,
  packSentencesNoTruncate,
} from "../semantic-summary-pagination";

export { buildRegionalSummaryFragment } from "./regional-summary";
export { buildSerpFragment, buildSerpScreenshotFragment } from "./serp";
export { buildSuggestionsFragment } from "./suggestions";
export { buildImagesFragment } from "./images";
export { buildIdentityFragment } from "./identity";
export { buildKnowledgeAiFragment } from "./knowledge-ai";
export { buildRelatedQueriesFragment } from "./related";
export { dedupeComplianceHits, buildComplianceFragment } from "./compliance";
export { buildAppendixFragment } from "./appendix";
