/**
 * Stage O5 — maps N1.3 classifier output to unified contentClass.
 */

import type { ResultClass } from "../risk-classifier/result-classifier";
import type { ContentClass } from "./types";

export function mapResultClassToContentClass(
  classification: string | null | undefined,
  surfaceType?: string
): ContentClass {
  const c = (classification ?? "").toUpperCase();
  switch (c) {
    case "LEGAL_DISPUTE":
    case "LEGAL":
      return "ADVERSE_LEGAL";
    case "ADVERSE_MEDIA":
    case "HIGH_RISK":
      return "ADVERSE_MEDIA";
    case "SANCTIONS":
      return "SANCTIONS";
    case "CRIMINAL":
      return "CRIMINAL";
    case "PEP":
      return "PEP_RCA";
    case "CORPORATE_REGISTRY":
    case "CORPORATE":
      return "CORPORATE_REGISTRY";
    case "SOCIAL_PROFILE":
      return "SOCIAL_PROFILE";
    case "BIOGRAPHY":
    case "AUTHORITY":
      return "BIOGRAPHY";
    case "NEWS":
      return "NEWS_NEUTRAL";
    case "NAMESAKE":
      return "NAMESAKE";
    case "ENTITY_MISMATCH":
    case "ENTITY_CONFUSION":
      return "ENTITY_MISMATCH";
    case "DUPLICATE":
    case "IRRELEVANT":
      return "LOW_VALUE";
    default:
      break;
  }
  if (surfaceType === "IMAGE_RESULT") return "IMAGE_NEUTRAL";
  if (surfaceType === "VIDEO_RESULT") return "VIDEO_NEUTRAL";
  if (surfaceType === "KNOWLEDGE_BLOCK") return "KNOWLEDGE_PANEL";
  if (surfaceType === "AI_ANSWER") return "AI_ANSWER";
  if (surfaceType === "WIKIPEDIA_RESULT") return "WIKIPEDIA";
  if (surfaceType === "RELATED_QUERY" || surfaceType === "SEARCH_SUGGESTION") {
    return "NEWS_NEUTRAL";
  }
  return "UNKNOWN";
}

export function isUsefulProfileContentClass(c: ContentClass): boolean {
  return (
    c === "BIOGRAPHY" ||
    c === "CORPORATE_REGISTRY" ||
    c === "NEWS_NEUTRAL" ||
    c === "SOCIAL_PROFILE" ||
    c === "KNOWLEDGE_PANEL" ||
    c === "WIKIPEDIA" ||
    c === "IMAGE_NEUTRAL" ||
    c === "VIDEO_NEUTRAL"
  );
}

export function isExcludedContentClass(c: ContentClass): boolean {
  return c === "NAMESAKE" || c === "ENTITY_MISMATCH" || c === "DUPLICATE" || c === "LOW_VALUE";
}

export function isAdverseContentClass(c: ContentClass): boolean {
  return (
    c === "ADVERSE_LEGAL" ||
    c === "ADVERSE_MEDIA" ||
    c === "SANCTIONS" ||
    c === "CRIMINAL" ||
    c === "PEP_RCA"
  );
}
