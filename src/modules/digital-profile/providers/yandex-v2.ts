/**
 * Pure helpers for the official Yandex Cloud Search API v2 (Stage N1).
 *
 * Endpoint: POST https://searchapi.api.cloud.yandex.net/v2/web/search
 * Auth:     Authorization: Api-Key <key>   (header — never in the URL/logs)
 *
 * The synchronous endpoint returns `{ rawData: <base64 XML> }`. We decode the
 * base64, guard against XXE / oversized payloads, and hand the XML to the
 * existing regex-based normalizer (no XML entity-expanding parser is used, so
 * external entities can never be resolved).
 *
 * This module is intentionally pure (no network, no secrets) so it is unit
 * testable by the smoke test with offline fixtures.
 */

export const YANDEX_V2_ENDPOINT =
  "https://searchapi.api.cloud.yandex.net/v2/web/search";

/** Max decoded XML we are willing to parse (anti-DoS). */
export const MAX_YANDEX_XML_BYTES = 8 * 1024 * 1024; // 8 MB

export type YandexSearchType =
  | "SEARCH_TYPE_RU"
  | "SEARCH_TYPE_TR"
  | "SEARCH_TYPE_COM"
  | "SEARCH_TYPE_KK"
  | "SEARCH_TYPE_BE"
  | "SEARCH_TYPE_UZ"
  | "SEARCH_TYPE_UK";

export type YandexLocalization =
  | "LOCALIZATION_RU"
  | "LOCALIZATION_BE"
  | "LOCALIZATION_KK"
  | "LOCALIZATION_UK"
  | "LOCALIZATION_TR"
  | "LOCALIZATION_EN";

/** Maps a config region ("ru"/"com"/"tr"/...) to a v2 searchType enum. */
export function toSearchType(region: string | undefined): YandexSearchType {
  switch ((region ?? "ru").trim().toLowerCase()) {
    case "tr":
      return "SEARCH_TYPE_TR";
    case "com":
    case "en":
    case "international":
      return "SEARCH_TYPE_COM";
    case "kk":
      return "SEARCH_TYPE_KK";
    case "be":
      return "SEARCH_TYPE_BE";
    case "uz":
      return "SEARCH_TYPE_UZ";
    case "uk":
      return "SEARCH_TYPE_UK";
    default:
      return "SEARCH_TYPE_RU";
  }
}

/** Maps a config localization ("ru"/"en"/...) to a v2 l10n enum. */
export function toLocalization(localization: string | undefined): YandexLocalization {
  switch ((localization ?? "ru").trim().toLowerCase()) {
    case "be":
      return "LOCALIZATION_BE";
    case "kk":
      return "LOCALIZATION_KK";
    case "uk":
      return "LOCALIZATION_UK";
    case "tr":
      return "LOCALIZATION_TR";
    case "en":
      return "LOCALIZATION_EN";
    default:
      return "LOCALIZATION_RU";
  }
}

export interface YandexV2BodyInput {
  queryText: string;
  folderId: string;
  /** 0-based page index. */
  page?: number;
  searchType: YandexSearchType;
  localization: YandexLocalization;
}

/** Builds the JSON request body for /v2/web/search (FORMAT_XML response). */
export function buildYandexV2Body(input: YandexV2BodyInput): Record<string, unknown> {
  return {
    query: {
      searchType: input.searchType,
      queryText: input.queryText,
      page: String(Math.max(0, input.page ?? 0)),
    },
    folderId: input.folderId,
    l10n: input.localization,
    responseFormat: "FORMAT_XML",
  };
}

export class YandexV2ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YandexV2ParseError";
  }
}

/** Extracts the base64 rawData field from a parsed v2 JSON response. */
function extractRawData(json: unknown): string {
  if (!json || typeof json !== "object") {
    throw new YandexV2ParseError("Empty response from Yandex Search API.");
  }
  const obj = json as Record<string, unknown>;
  // Sync endpoint: { rawData }. Some shapes nest under response/result.
  const candidate =
    obj.rawData ??
    (obj.response as Record<string, unknown> | undefined)?.rawData ??
    (obj.result as Record<string, unknown> | undefined)?.rawData;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new YandexV2ParseError("Yandex Search API response is missing rawData.");
  }
  return candidate;
}

/**
 * Decodes the base64 `rawData` of a v2 response into the XML string, rejecting
 * oversized payloads and any DOCTYPE/ENTITY declarations (defense-in-depth
 * against XXE — the normalizer itself is regex-based and never expands
 * entities).
 */
export function decodeYandexV2RawData(json: unknown): string {
  const rawData = extractRawData(json);
  let xml: string;
  try {
    const buf = Buffer.from(rawData, "base64");
    if (buf.byteLength > MAX_YANDEX_XML_BYTES) {
      throw new YandexV2ParseError("Yandex Search API XML payload too large.");
    }
    xml = buf.toString("utf8");
  } catch (err) {
    if (err instanceof YandexV2ParseError) throw err;
    throw new YandexV2ParseError("Could not base64-decode Yandex rawData.");
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new YandexV2ParseError("Rejected XML containing a DOCTYPE/ENTITY declaration (XXE guard).");
  }
  return xml;
}
