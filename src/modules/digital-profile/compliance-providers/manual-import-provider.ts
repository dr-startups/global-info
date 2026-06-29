/**
 * Stage C1 — manual compliance import provider (always available).
 */

import { getComplianceProviderStatus } from "./config";
import type { ComplianceProvider } from "./provider-interface";
import type { ComplianceScreeningRequest, ComplianceScreeningResult } from "./types";

export const manualImportProvider: ComplianceProvider = {
  name: "MANUAL_IMPORT",
  kind: "MANUAL",
  getStatus() {
    return getComplianceProviderStatus("MANUAL_IMPORT");
  },
  async screenPerson(_request: ComplianceScreeningRequest): Promise<ComplianceScreeningResult> {
    return {
      status: "NOT_CONFIGURED",
      provider: "MANUAL_IMPORT",
      hits: [],
      error: {
        code: "USE_MANUAL_IMPORT_API",
        message: "Use the manual import endpoint to add compliance hits.",
        retryable: false,
      },
    };
  },
};
