/**
 * Arsenkin UI orchestration — split from arsenkin-ui-orchestration-service.ts
 * (REMEDIATION §9.5) — mechanical move only.
 */

export type {
  ArsenkinUiStatusCode,
  ArsenkinUiStage,
  ArsenkinUiStatusDto,
  ArsenkinUiPlanRequestDto,
  ArsenkinUiPlanDto,
  ArsenkinSurfaceMatrixStatus,
  ArsenkinSurfaceMatrixRow,
  ArsenkinRecoveryUiState,
  ArsenkinUiOrchestrationDeps,
} from "./types";

export type { ArsenkinUiRunMapping } from "./shared";
export {
  arsenkinBudgetForStage,
  arsenkinCanaryOutRoot,
  arsenkinOrionCaseRoot,
  arsenkinUiRunMappingPath,
  loadArsenkinUiRunMapping,
  saveArsenkinUiRunMapping,
  generateArsenkinReportRunId,
  resolveMappedArsenkinReportRunId,
  hasBlockingRecovery,
  buildRecoveryUiState,
} from "./shared";

export { refreshArsenkinDbReadinessForUi, getArsenkinUiStatus } from "./poll";
export {
  prepareArsenkinUiRun,
  buildArsenkinUiPlan,
  planArsenkinUiRun,
  executeArsenkinUiPlan,
  executeArsenkinUiRun,
} from "./submit";
export { syncArsenkinResultsToOrion } from "./ingest";
export { parseArsenkinUiStage, toPublicArsenkinUiDto } from "./dto";

