/**
 * Arsenkin suggest → SerpObservation(surface=autocomplete).
 */

import { createHash } from "node:crypto";
import { buildSerpQueryId } from "../../../serp-observation/query-id";
import type { SerpObservationDraft } from "../../../serp-observation/types";
import { seTypeToEngine } from "../regions";

export type SuggestRequestInput = {
  queries: string[];
  /** 1=Yandex, 2=Google, 3=YouTube */
  se: 1 | 2 | 3;
  region: number;
  depth?: 1 | 2 | 3;
  check?: string[];
  google_domain?: string;
  google_from?: string;
  google_lang?: string;
  stoplist?: string[];
};

export function buildSuggestRequest(input: SuggestRequestInput): {
  tools_name: "suggest";
  data: Record<string, unknown>;
} {
  const data: Record<string, unknown> = {
    queries: input.queries,
    se: input.se,
    region: input.region,
    depth: input.depth ?? 1,
    check: input.check ?? ["nrm", "spc", "cyr"],
  };
  if (input.se === 2 || input.se === 3) {
    data.google_domain = input.google_domain ?? "www.google.ru";
    data.google_from = input.google_from ?? "RU";
    data.google_lang = input.google_lang ?? "ru";
  }
  if (input.stoplist?.length) data.stoplist = input.stoplist;
  return { tools_name: "suggest", data };
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function extractSuggestions(payload: unknown, seedQuery: string): string[] {
  const root = asObj(payload);
  const result = asObj(root.result);
  const inner = asObj(result.result ?? result);
  const candidates: unknown[] = [];
  const OPTION_CODES = new Set([
    "nrm",
    "spc",
    "lat",
    "cyr",
    "dig",
    "loc",
    "sho",
    "quo",
    "otzyv",
  ]);

  // Live Arsenkin: result.types = { phrase: typeCode }, result.result = { "0": [phrases], ... }
  const types = asObj(result.types ?? inner.types);
  for (const phrase of Object.keys(types)) {
    if (phrase.trim()) candidates.push(phrase);
  }
  const byBucket = asObj(result.result ?? inner.result);
  for (const v of Object.values(byBucket)) {
    if (Array.isArray(v)) candidates.push(...v);
  }
  // Direct list under result.result when it's an array
  if (Array.isArray(result.result)) candidates.push(...result.result);
  if (Array.isArray(inner.result)) candidates.push(...(inner.result as unknown[]));

  for (const key of ["suggests", "suggestions", "words", "phrases", "items"]) {
    const v = inner[key] ?? result[key] ?? root[key];
    if (Array.isArray(v)) {
      // Skip Arsenkin check-option arrays
      if (v.every((x) => typeof x === "string" && OPTION_CODES.has(String(x).toLowerCase()))) {
        continue;
      }
      candidates.push(...v);
    }
  }

  const hit = types[seedQuery] ? null : (byBucket[seedQuery] ?? result[seedQuery]);
  if (Array.isArray(hit)) candidates.push(...hit);

  const NOISE = new Set([...OPTION_CODES, "check", "depth", "stoplist", "b", "w", "gen", "t", "pb", "nav", "rich", "fast", "in"]);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    let text = "";
    if (typeof c === "string") text = c;
    else if (c && typeof c === "object") {
      const o = asObj(c);
      text = String(o.phrase ?? o.word ?? o.query ?? o.text ?? o.suggest ?? "").trim();
    }
    text = text.trim();
    if (!text || NOISE.has(text.toLowerCase())) continue;
    if (seen.has(text.toLowerCase())) continue;
    if (/^[a-z]{1,5}$/i.test(text)) continue;
    seen.add(text.toLowerCase());
    out.push(text);
  }
  return out;
}

function syntheticSuggestUrl(queryText: string, suggestion: string, rank: number): string {
  const h = createHash("sha1").update(`${queryText}|${suggestion}|${rank}`).digest("hex").slice(0, 12);
  return `arsenkin://suggest/${h}`;
}

export function mapSuggestToObservations(input: {
  caseId: string;
  auditRunId: string;
  regionLabel: string;
  language: string;
  queries: string[];
  se: 1 | 2 | 3;
  payload: unknown;
  capturedAt?: Date;
}): SerpObservationDraft[] {
  const capturedAt = input.capturedAt ?? new Date();
  const engine = input.se === 1 ? "YANDEX" : "GOOGLE";
  const drafts: SerpObservationDraft[] = [];
  for (const queryText of input.queries) {
    const suggestions = extractSuggestions(input.payload, queryText);
    const queryId = buildSerpQueryId({
      auditRunId: input.auditRunId,
      provider: "arsenkin",
      engine,
      region: input.regionLabel,
      language: input.language,
      queryText,
      surface: "autocomplete",
    });
    suggestions.forEach((suggestion, idx) => {
      const rank = idx + 1;
      drafts.push({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        queryId,
        queryText,
        provider: "arsenkin",
        engine,
        surface: "autocomplete",
        region: input.regionLabel,
        language: input.language,
        rank,
        url: syntheticSuggestUrl(queryText, suggestion, rank),
        title: suggestion,
        snippet: null,
        domain: "suggest",
        providerStatus: "OK",
        rawPayloadJson: {
          source: "arsenkin",
          tool: "suggest",
          se: input.se,
          suggestion,
        },
        capturedAt,
      });
    });
  }
  return drafts;
}
