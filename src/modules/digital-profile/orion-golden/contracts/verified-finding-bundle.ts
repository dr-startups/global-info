import { z } from "zod";
import { ContractEnvelopeSchema, SubjectRelevanceDecisionSchema } from "./common";
import { FindingSchema } from "./finding";

export const VERIFIED_FINDING_BUNDLE_SCHEMA_VERSION = "verified-finding-bundle-v1" as const;

export const VerifiedFindingBundleSchema = ContractEnvelopeSchema.extend({
  schemaVersion: z.literal(VERIFIED_FINDING_BUNDLE_SCHEMA_VERSION),
  /** Only SUBJECT_MATCH may feed KPI; LIKELY_SUBJECT is visible but not KPI-eligible (§2.1). */
  kpiEligibleSubjectMatches: z.array(SubjectRelevanceDecisionSchema),
  findings: z.array(FindingSchema),
  excludedFindingIds: z.array(z.string()),
  exclusionReasons: z.record(z.string()),
});

export type VerifiedFindingBundle = z.infer<typeof VerifiedFindingBundleSchema>;
