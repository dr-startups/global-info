import { AssembledDeckModelSchema } from "./assembled-deck-model";
import { CompositeDatasetSchema } from "./composite-dataset";
import { ExecutiveSummarySchema } from "./executive-summary";
import { FindingSchema } from "./finding";
import { SectionPackSchema } from "./section-pack";
import { SubjectResolutionSchema } from "./subject-resolution";
import { SurfaceAnalysisSchema } from "./surface-analysis";
import { SurfaceFragmentSchema } from "./surface-fragment";
import { VerifiedFindingBundleSchema } from "./verified-finding-bundle";

export const STAGE1_CONTRACT_VALIDATORS = {
  CompositeDataset: CompositeDatasetSchema,
  SubjectResolution: SubjectResolutionSchema,
  SurfaceAnalysis: SurfaceAnalysisSchema,
  Finding: FindingSchema,
  VerifiedFindingBundle: VerifiedFindingBundleSchema,
  ExecutiveSummary: ExecutiveSummarySchema,
  SectionPack: SectionPackSchema,
  SurfaceFragment: SurfaceFragmentSchema,
  AssembledDeckModel: AssembledDeckModelSchema,
} as const;

export type Stage1ContractName = keyof typeof STAGE1_CONTRACT_VALIDATORS;

export function validateStage1Contract(name: Stage1ContractName, raw: unknown) {
  return STAGE1_CONTRACT_VALIDATORS[name].safeParse(raw);
}

export function parseStage1Contract(name: Stage1ContractName, raw: unknown) {
  return STAGE1_CONTRACT_VALIDATORS[name].parse(raw);
}
