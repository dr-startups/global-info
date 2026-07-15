/** Submit-failure diagnostics for ProviderTask.responseJson (no secrets). */

import { ArsenkinRequestError } from "./client";
import { redactDeep } from "./redact";

export function buildSubmitFailureDiagnostics(error: unknown): Record<string, unknown> {
  const requestError = error instanceof ArsenkinRequestError ? error : null;
  return {
    _submitDiagnostics: {
      httpStatus: requestError?.options.status ?? null,
      code: requestError?.options.code ?? null,
      uncertain: Boolean(requestError?.options.uncertain),
      message: requestError?.message ?? (error instanceof Error ? error.message : String(error)),
      responseBody: redactDeep(requestError?.options.raw ?? null),
      loggedAt: new Date().toISOString(),
    },
  };
}
