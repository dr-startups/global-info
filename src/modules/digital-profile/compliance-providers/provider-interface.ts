/**
 * Stage C1 — compliance provider interface.
 */

import type {
  ComplianceProviderName,
  ComplianceProviderStatus,
  ComplianceScreeningRequest,
  ComplianceScreeningResult,
} from "./types";

export interface ComplianceProvider {
  readonly name: ComplianceProviderName;
  readonly kind: "REAL" | "MANUAL" | "MOCK";
  getStatus(): ComplianceProviderStatus;
  screenPerson(request: ComplianceScreeningRequest): Promise<ComplianceScreeningResult>;
}
