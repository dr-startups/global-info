/**
 * Arsenkin suggest → SerpObservation(surface=autocomplete).
 * Request builder is fail-closed against schema that Arsenkin rejects
 * (e.g. empty/non-array queries, Cyrillic on Google/YouTube suggest).
 */

import { createHash } from "node:crypto";
import { buildSerpQueryId } from "../../../serp-observation/query-id";
import type { SerpObservationDraft } from "../../../serp-observation/types";
import { seTypeToEngine } from "../regions";

/** Arsenkin suggest accepts up to 100 phrases; keep CaseAgent budgets tight. */
export const ARSENKIN_SUGGEST_MAX_QUERIES = 5;
/** Defensive per-phrase cap — overly long phrases trigger JSON_VALIDATION_ERROR on queries. */
export const ARSENKIN_SUGGEST_MAX_QUERY_CHARS = 80;

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

export type SuggestRequestValidation =
  | { ok: true; queries: string[] }
  | { ok: false; code: "SUGGEST_QUERIES_INVALID"; message: string };

const CHECK_ALLOWED = new Set(["nrm", "spc", "lat", "cyr", "dig", "loc", "sho", "quo", "otzyv"]);

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/i.test(value);
}

function hasLatinLetter(value: string): boolean {
  return /[A-Za-z]/.test(value);
}

/**
 * Normalize suggest queries for the target SE.
 * Google/YouTube reject Cyrillic-only phrases in `queries` (JSON_VALIDATION_ERROR).
 * Yandex accepts Cyrillic; drop empty / oversized phrases universally.
 */
export function normalizeSuggestQueries(input: {
  queries: unknown;
  se: 1 | 2 | 3;
}): SuggestRequestValidation {
  if (!Array.isArray(input.queries)) {
    return {
      ok: false,
      code: "SUGGEST_QUERIES_INVALID",
      message: "suggest.queries must be a non-empty string array",
    };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.queries) {
    if (typeof raw !== "string" && typeof raw !== "number") {
      return {
        ok: false,
        code: "SUGGEST_QUERIES_INVALID",
        message: "suggest.queries items must be strings",
      };
    }
    let q = String(raw ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (!q) continue;
    if (q.length > ARSENKIN_SUGGEST_MAX_QUERY_CHARS) {
      q = q.slice(0, ARSENKIN_SUGGEST_MAX_QUERY_CHARS).trim();
    }
    if (!q) continue;
    // Google / YouTube: require at least one Latin letter; skip pure Cyrillic.
    if ((input.se === 2 || input.se === 3) && hasCyrillic(q) && !hasLatinLetter(q)) {
      continue;
    }
    const key = q.toLocaleLowerCase("ru-RU");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(q);
    if (out.length >= ARSENKIN_SUGGEST_MAX_QUERIES) break;
  }
  if (out.length === 0) {
    return {
      ok: false,
      code: "SUGGEST_QUERIES_INVALID",
      message:
        input.se === 2 || input.se === 3
          ? "suggest.queries empty after Latin-only filter for Google/YouTube"
          : "suggest.queries empty after normalize",
    };
  }
  return { ok: true, queries: out };
}

export function buildSuggestRequest(input: SuggestRequestInput): {
  tools_name: "suggest";
  data: Record<string, unknown>;
} {
  const normalized = normalizeSuggestQueries({ queries: input.queries, se: input.se });
  if (!normalized.ok) {
    throw new Error(`${normalized.code}:${normalized.message}`);
  }
  const check = (input.check ?? ["nrm", "spc", "cyr"])
    .map((c) => String(c ?? "").trim().toLowerCase())
    .filter((c) => CHECK_ALLOWED.has(c));
  const data: Record<string, unknown> = {
    queries: normalized.queries,
    se: input.se,
    region: Number(input.region),
    depth: input.depth === 2 || input.depth === 3 ? input.depth : 1,
    check: check.length > 0 ? check : ["nrm", "spc", "cyr"],
  };
  if (input.se === 2 || input.se === 3) {
    data.google_domain = String(input.google_domain ?? "www.google.ru").trim() || "www.google.ru";
    data.google_from = String(input.google_from ?? "RU").trim() || "RU";
    data.google_lang = String(input.google_lang ?? "ru").trim() || "ru";
  }
  if (input.stoplist?.length) {
    data.stoplist = input.stoplist.map((s) => String(s ?? "").trim()).filter(Boolean);
  }
  return { tools_name: "suggest", data };
}

/** Safe builder for retry paths — never throws; returns validation error instead. */
export function tryBuildSuggestRequest(input: SuggestRequestInput):
  | { ok: true; request: { tools_name: "suggest"; data: Record<string, unknown> } }
  | { ok: false; code: string; message: string } {
  try {
    return { ok: true, request: buildSuggestRequest(input) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.startsWith("SUGGEST_QUERIES_INVALID")
      ? "SUGGEST_QUERIES_INVALID"
      : "SUGGEST_REQUEST_INVALID";
    return { ok: false, code, message };
  }
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

  const types = asObj(result.types ?? inner.types);
  for (const phrase of Object.keys(types)) {
    if (phrase.trim()) candidates.push(phrase);
  }
  const byBucket = asObj(result.result ?? inner.result);
  for (const v of Object.values(byBucket)) {
    if (Array.isArray(v)) candidates.push(...v);
  }
  if (Array.isArray(result.result)) candidates.push(...result.result);
  if (Array.isArray(inner.result)) candidates.push(...(inner.result as unknown[]));

  for (const key of ["suggests", "suggestions", "words", "phrases", "items"]) {
    const v = inner[key] ?? result[key] ?? root[key];
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === "string" && OPTION_CODES.has(String(x).toLowerCase()))) {
        continue;
      }
      candidates.push(...v);
    }
  }

  const hit = types[seedQuery] ? null : (byBucket[seedQuery] ?? result[seedQuery]);
  if (Array.isArray(hit)) candidates.push(...hit);

  const NOISE = new Set([
    ...OPTION_CODES,
    "check",
    "depth",
    "stoplist",
    "b",
    "w",
    "gen",
    "t",
    "pb",
    "nav",
    "rich",
    "fast",
    "in",
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

void seTypeToEngine;
