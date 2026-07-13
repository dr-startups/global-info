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
    check: input.check ?? ["nrm", "spc"],
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
  for (const key of ["result", "suggests", "suggestions", "words", "phrases", "items"]) {
    const v = inner[key] ?? result[key] ?? root[key];
    if (Array.isArray(v)) candidates.push(...v);
  }
  // Nested maps: result[query] = string[] (at inner or result level)
  for (const mapCandidate of [inner, result, asObj(inner.result), asObj(result.result)]) {
    if (!mapCandidate || Array.isArray(mapCandidate)) continue;
    const hit = mapCandidate[seedQuery];
    if (Array.isArray(hit)) candidates.push(...hit);
    else {
      for (const v of Object.values(mapCandidate)) {
        if (Array.isArray(v) && v.every((x) => typeof x === "string" || (x && typeof x === "object"))) {
          candidates.push(...v);
          break;
        }
      }
    }
  }
  const NOISE = new Set([
    "nrm",
    "spc",
    "lat",
    "cyr",
    "dig",
    "loc",
    "sho",
    "quo",
    "otzyv",
    "check",
    "depth",
    "stoplist",
  ]);
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
    // Drop option-code pollution and trivial exact seed echoes only when alone later.
    if (/^[a-z]{2,5}$/i.test(text) && text.length <= 5) continue;
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
