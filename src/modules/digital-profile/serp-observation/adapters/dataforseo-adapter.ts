/**
 * DataForSEO adapter stub — alternate Google SERP provider.
 * Not wired in the Serper vertical slice; reserved for later.
 * No browser scraping / CAPTCHA bypass.
 */

import type { SerpObservationDraft, SerpProviderStatus } from "../types";

export type DataForSeoOrganicRequest = {
  caseId: string;
  auditRunId: string;
  queryText: string;
  region: string;
  language: string;
  limit?: number;
};

export type DataForSeoOrganicResult = {
  status: SerpProviderStatus;
  observations: SerpObservationDraft[];
  message?: string;
};

export function isDataForSeoConfigured(): boolean {
  return Boolean(process.env.DATAFORSEO_LOGIN?.trim() && process.env.DATAFORSEO_PASSWORD?.trim());
}

/**
 * Placeholder: returns NOT_CONFIGURED until credentials + mapping are implemented.
 */
export async function fetchDataForSeoOrganic(
  _request: DataForSeoOrganicRequest
): Promise<DataForSeoOrganicResult> {
  if (!isDataForSeoConfigured()) {
    return {
      status: "PROVIDER_NOT_CONFIGURED",
      observations: [],
      message: "DataForSEO credentials not configured",
    };
  }
  return {
    status: "PROVIDER_FAILED",
    observations: [],
    message: "DataForSEO organic adapter not implemented in this slice",
  };
}
