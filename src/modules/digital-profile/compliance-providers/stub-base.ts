/**
 * Stage C1 — shared stub logic for paid compliance API adapters.
 * No HTTP calls, no fake results.
 */

import { getComplianceProviderStatus, missingComplianceConfigKeys } from "./config";
import type { ComplianceProvider } from "./provider-interface";
import type {
  ComplianceProviderName,
  ComplianceScreeningRequest,
  ComplianceScreeningResult,
} from "./types";

export function createRealComplianceStub(name: ComplianceProviderName): ComplianceProvider {
  return {
    name,
    kind: "REAL",
    getStatus() {
      return getComplianceProviderStatus(name);
    },
    async screenPerson(request: ComplianceScreeningRequest): Promise<ComplianceScreeningResult> {
      const status = getComplianceProviderStatus(name);
      if (status.status === "DISABLED") {
        return {
          status: "DISABLED",
          provider: name,
          hits: [],
          error: {
            code: "PROVIDER_DISABLED",
            message: `${status.label} is disabled. Use manual import or enable in configuration.`,
            retryable: false,
          },
        };
      }
      if (status.status === "NOT_CONFIGURED") {
        return {
          status: "NOT_CONFIGURED",
          provider: name,
          hits: [],
          error: {
            code: "PROVIDER_NOT_CONFIGURED",
            message: `${status.label} is not configured. Missing: ${missingComplianceConfigKeys(name).join(", ")}.`,
            retryable: false,
          },
        };
      }
      // ENABLED but no official integration wired yet — explicit error, no silent mock.
      return {
        status: "PROVIDER_ERROR",
        provider: name,
        hits: [],
        error: {
          code: "PROVIDER_NOT_IMPLEMENTED",
          message: `${status.label} credentials are present but live API integration is not enabled in this release. Use manual import.`,
          retryable: false,
        },
      };
    },
  };
}
