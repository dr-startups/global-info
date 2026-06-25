/**
 * Provider surface capabilities (Stage H3).
 *
 * Declares, per provider, which search surfaces are deliverable and how:
 *  - OFFICIAL_API  — supported by the current official-API adapter
 *  - MANUAL_IMPORT — only available via analyst manual import
 *  - SYNTHETIC     — can be produced as a safe synthetic snapshot (not a live SERP)
 *  - NOT_SUPPORTED — not available through any safe/official path here
 *
 * We deliberately mark surfaces the current adapters do NOT yet implement as
 * NOT_SUPPORTED (rather than pretending). No scraping/browser fallbacks exist.
 */

import type { ProviderName } from "./config";
import type { ProviderCapabilities } from "../search-surfaces/types";

const GOOGLE: ProviderCapabilities = {
  organicSearch: { supported: true, method: "OFFICIAL_API" },
  imageSearch: { supported: false, method: "NOT_SUPPORTED" },
  videoSearch: { supported: false, method: "NOT_SUPPORTED" },
  suggestions: { supported: false, method: "NOT_SUPPORTED" },
  relatedQueries: { supported: false, method: "NOT_SUPPORTED" },
  knowledgeBlock: { supported: true, method: "MANUAL_IMPORT" },
  screenshots: { supported: true, method: "SYNTHETIC" },
  manualImport: { supported: true, method: "MANUAL_IMPORT" },
};

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

const CAPABILITIES: Record<ProviderName, ProviderCapabilities> = {
  GOOGLE,
  YANDEX,
  WIKIPEDIA,
};

export function getProviderCapabilities(name: ProviderName): ProviderCapabilities {
  return CAPABILITIES[name];
}
