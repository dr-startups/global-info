/**
 * Arsenkin suggest → SerpObservation(surface=autocomplete).
 * Request builder is fail-closed against schema that Arsenkin rejects
 * (empty queries, >1 query per task, Cyrillic on Google/YouTube suggest).
 *
 * Production Arsenkin contract: each suggest ProviderTask accepts exactly
 * one element in `queries` ("Не более 1 элементов").
 */

import { createHash } from "node:crypto";
import { buildSerpQueryId } from "../../../serp-observation/query-id";
import type { SerpObservationDraft } from "../../../serp-observation/types";
import { seTypeToEngine } from "../regions";

/** Arsenkin suggest accepts exactly one phrase per paid ProviderTask. */
export const ARSENKIN_SUGGEST_MAX_QUERIES = 1;
/** Defensive per-phrase cap — overly long phrases trigger JSON_VALIDATION_ERROR on queries. */
export const ARSENKIN_SUGGEST_MAX_QUERY_CHARS = 80;

export type SuggestRequestInput = {
  /** Candidate phrases — builder selects exactly one deterministically. */
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
  /**
   * Optional identity hints (subject-agnostic). Prefer these when present in
   * the candidate set — never hardcode person names.
   */
  primaryLocalized?: string | null;
  primaryLatin?: string | null;
};

export type SuggestQuerySelection = {
  selectedQuery: string;
  selectedQueryHash: string;
  selectionReason: string;
  candidateQueryCount: number;
  /** SHA-256 of rejected normalized candidates (no client text). */
  rejectedCandidateHashes: string[];
};

export type SuggestRequestValidation =
  | { ok: true; queries: [string]; selection: SuggestQuerySelection }
  | { ok: false; code: "SUGGEST_QUERIES_INVALID" | "SUGGEST_QUERY_UNAVAILABLE"; message: string };

const CHECK_ALLOWED = new Set(["nrm", "spc", "lat", "cyr", "dig", "loc", "sho", "quo", "otzyv"]);

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/i.test(value);
}

function hasLatinLetter(value: string): boolean {
  return /[A-Za-z]/.test(value);
}

/**
 * Locale-independent key for dedupe / scoring / tie-break.
 * Avoids fixed `ru-RU` / ICU localeCompare so Turkish/Latin/Arabic
 * subjects select identically across Node/OS runtimes.
 */
function normKey(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function compareNormKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function hashQuery(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePhrase(raw: unknown): string | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  let q = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!q) return null;
  if (q.length > ARSENKIN_SUGGEST_MAX_QUERY_CHARS) {
    q = q.slice(0, ARSENKIN_SUGGEST_MAX_QUERY_CHARS).trim();
  }
  return q || null;
}

/**
 * Deterministic, order-independent selection of exactly one suggest query.
 * Yandex: prefer canonical localized (Cyrillic) full name.
 * Google/YouTube: prefer canonical Latin/transliterated form; reject pure Cyrillic.
 */
export function selectCanonicalSuggestQuery(input: {
  se: 1 | 2 | 3;
  candidates: unknown;
  primaryLocalized?: string | null;
  primaryLatin?: string | null;
}): SuggestRequestValidation {
  if (!Array.isArray(input.candidates)) {
    return {
      ok: false,
      code: "SUGGEST_QUERIES_INVALID",
      message: "suggest.queries must be a non-empty string array",
    };
  }

  const primaryLocalized = normalizePhrase(input.primaryLocalized ?? "");
  const primaryLatin = normalizePhrase(input.primaryLatin ?? "");
  const preferredSurfaces = [primaryLocalized, primaryLatin].filter(
    (v): v is string => typeof v === "string" && v.length > 0
  );

  /** Dedupe by normKey; prefer canonical primary surface, else stable code-unit order. */
  const byKey = new Map<string, string>();
  for (const raw of input.candidates) {
    if (typeof raw !== "string" && typeof raw !== "number" && raw != null) {
      return {
        ok: false,
        code: "SUGGEST_QUERIES_INVALID",
        message: "suggest.queries items must be strings",
      };
    }
    const q = normalizePhrase(raw);
    if (!q) continue;
    const key = normKey(q);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, q);
      continue;
    }
    if (preferredSurfaces.some((p) => p === q)) {
      byKey.set(key, q);
      continue;
    }
    if (preferredSurfaces.some((p) => p === existing)) continue;
    if (compareNormKeys(q, existing) < 0) byKey.set(key, q);
  }
  const normalized = [...byKey.values()].sort((a, b) => compareNormKeys(normKey(a), normKey(b)));

  type Scored = { query: string; score: number; reason: string };
  const scored: Scored[] = [];
  for (const q of normalized) {
    const cyr = hasCyrillic(q);
    const lat = hasLatinLetter(q);
    if (input.se === 2 || input.se === 3) {
      // Google / YouTube: require Latin; skip pure Cyrillic.
      if (cyr && !lat) continue;
      if (!lat) continue;
      let score = 10;
      let reason = "latin-eligible";
      if (primaryLatin && normKey(q) === normKey(primaryLatin)) {
        score = 100;
        reason = "canonical-latin-primary";
      } else if (primaryLatin && normKey(q).includes(normKey(primaryLatin))) {
        score = 80;
        reason = "contains-canonical-latin-primary";
      } else if (!cyr && lat) {
        score = 40;
        reason = "latin-only";
      }
      scored.push({ query: q, score, reason });
      continue;
    }
    // Yandex: prefer localized Cyrillic canonical full name. A reversed FIO
    // gets no rank of its own — it is not a spelling of the name, and scoring
    // it just below canonical once made the paid suggest task ask for it.
    let score = 10;
    let reason = "yandex-eligible";
    if (primaryLocalized && normKey(q) === normKey(primaryLocalized)) {
      score = 100;
      reason = "canonical-localized-primary";
    } else if (cyr) {
      score = 50;
      reason = "cyrillic-identity";
    } else if (lat) {
      score = 20;
      reason = "latin-fallback";
    }
    scored.push({ query: q, score, reason });
  }

  if (scored.length === 0) {
    return {
      ok: false,
      code: "SUGGEST_QUERY_UNAVAILABLE",
      message:
        input.se === 2 || input.se === 3
          ? "suggest.queries: no Latin-eligible query for Google/YouTube"
          : "suggest.queries: no usable query after normalize",
    };
  }

  // Order-independent: highest score, then normKey, then surface form.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byNorm = compareNormKeys(normKey(a.query), normKey(b.query));
    if (byNorm !== 0) return byNorm;
    return compareNormKeys(a.query, b.query);
  });
  const winner = scored[0]!;
  const rejectedCandidateHashes = scored
    .slice(1)
    .map((s) => hashQuery(normKey(s.query)))
    .sort();

  const selection: SuggestQuerySelection = {
    selectedQuery: winner.query,
    selectedQueryHash: hashQuery(normKey(winner.query)),
    selectionReason: winner.reason,
    candidateQueryCount: normalized.length,
    rejectedCandidateHashes,
  };
  return { ok: true, queries: [winner.query], selection };
}

/**
 * Normalize suggest queries for the target SE → exactly one phrase.
 */
export function normalizeSuggestQueries(input: {
  queries: unknown;
  se: 1 | 2 | 3;
  primaryLocalized?: string | null;
  primaryLatin?: string | null;
}): SuggestRequestValidation {
  return selectCanonicalSuggestQuery({
    se: input.se,
    candidates: input.queries,
    primaryLocalized: input.primaryLocalized,
    primaryLatin: input.primaryLatin,
  });
}

export function buildSuggestRequest(input: SuggestRequestInput): {
  tools_name: "suggest";
  data: Record<string, unknown>;
  selection: SuggestQuerySelection;
} {
  const selected = selectCanonicalSuggestQuery({
    se: input.se,
    candidates: input.queries,
    primaryLocalized: input.primaryLocalized,
    primaryLatin: input.primaryLatin,
  });
  if (!selected.ok) {
    throw new Error(`${selected.code}:${selected.message}`);
  }
  if (selected.queries.length !== ARSENKIN_SUGGEST_MAX_QUERIES) {
    throw new Error("SUGGEST_QUERIES_INVALID:exactly one query required");
  }
  const check = (input.check ?? ["nrm", "spc", "cyr"])
    .map((c) => String(c ?? "").trim().toLowerCase())
    .filter((c) => CHECK_ALLOWED.has(c));
  const data: Record<string, unknown> = {
    queries: selected.queries,
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
  return { tools_name: "suggest", data, selection: selected.selection };
}

/** Safe builder for retry paths — never throws; returns validation error instead. */
export function tryBuildSuggestRequest(input: SuggestRequestInput):
  | {
      ok: true;
      request: { tools_name: "suggest"; data: Record<string, unknown> };
      selection: SuggestQuerySelection;
    }
  | { ok: false; code: string; message: string } {
  try {
    const built = buildSuggestRequest(input);
    return { ok: true, request: { tools_name: built.tools_name, data: built.data }, selection: built.selection };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.startsWith("SUGGEST_QUERY_UNAVAILABLE")
      ? "SUGGEST_QUERY_UNAVAILABLE"
      : message.startsWith("SUGGEST_QUERIES_INVALID")
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
  // Map against at most one seed query (Arsenkin suggest task contract).
  const seedQueries = input.queries.slice(0, 1);
  for (const queryText of seedQueries) {
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
