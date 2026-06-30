/**
 * Provider surface capabilities (Stage H3 + O2).
 *
 * Declares, per provider, which search surfaces are deliverable and how.
 * Google capabilities reflect Serper availability when external_serp is configured.
 */

import type { ProviderName } from "./config";
import { providerConfig } from "./config";
import type { ProviderCapabilities, SurfaceCapability } from "../search-surfaces/types";

function cap(supported: boolean, method: SurfaceCapability["method"]): SurfaceCapability {
  return { supported, method };
}

function serperReady(): boolean {
  const ext = providerConfig.google.external;
  return ext.provider === "serper" && Boolean(ext.apiKey?.trim());
}

function buildGoogleCapabilities(): ProviderCapabilities {
  const ready = serperReady();
  return {
    organicSearch: cap(ready, "OFFICIAL_API"),
    imageSearch: cap(ready, ready ? "OFFICIAL_API" : "NOT_SUPPORTED"),
    videoSearch: cap(ready, ready ? "OFFICIAL_API" : "NOT_SUPPORTED"),
    suggestions: cap(ready, ready ? "OFFICIAL_API" : "NOT_SUPPORTED"),
    relatedQueries: cap(ready, ready ? "OFFICIAL_API" : "NOT_SUPPORTED"),
    knowledgeBlock: cap(ready, ready ? "OFFICIAL_API" : "MANUAL_IMPORT"),
    screenshots: cap(true, "SYNTHETIC"),
    manualImport: cap(true, "MANUAL_IMPORT"),
  };
}

const YANDEX: ProviderCapabilities = {
  organicSearch: { supported: true, method: "OFFICIAL_API" },
  imageSearch: { supported: false, method: "NOT_SUPPORTED" },
  videoSearch: { supported: false, method: "NOT_SUPPORTED" },
  suggestions: { supported: false, method: "NOT_SUPPORTED" },
  relatedQueries: { supported: false, method: "NOT_SUPPORTED" },
  knowledgeBlock: { supported: true, method: "MANUAL_IMPORT" },
  screenshots: { supported: true, method: "SYNTHETIC" },
  manualImport: { supported: true, method: "MANUAL_IMPORT" },
};

const WIKIPEDIA: ProviderCapabilities = {
  organicSearch: { supported: false, method: "NOT_SUPPORTED" },
  imageSearch: { supported: false, method: "NOT_SUPPORTED" },
  videoSearch: { supported: false, method: "NOT_SUPPORTED" },
  suggestions: { supported: false, method: "NOT_SUPPORTED" },
  relatedQueries: { supported: false, method: "NOT_SUPPORTED" },
  knowledgeBlock: { supported: true, method: "OFFICIAL_API" },
  screenshots: { supported: false, method: "NOT_SUPPORTED" },
  manualImport: { supported: true, method: "MANUAL_IMPORT" },
};

export function getProviderCapabilities(name: ProviderName): ProviderCapabilities {
  if (name === "GOOGLE") return buildGoogleCapabilities();
  if (name === "YANDEX") return YANDEX;
  return WIKIPEDIA;
}
