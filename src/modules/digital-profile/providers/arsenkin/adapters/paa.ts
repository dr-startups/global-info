/**
 * Arsenkin paa → SerpObservation(surface=paa).
 * Note: Arsenkin PAA is Google-only (Yandex block removed).
 */

import { createHash } from "node:crypto";
import { buildSerpQueryId } from "../../../serp-observation/query-id";
import type { SerpObservationDraft } from "../../../serp-observation/types";

export type PaaRequestInput = {
  queries: string[];
  region: number;
  depth?: 1 | 2 | 3;
  count?: 5 | 10 | 20 | 30 | 40 | 50;
  google_domain?: string;
  google_from?: string;
  google_lang?: string;
};

export function buildPaaRequest(input: PaaRequestInput): {
  tools_name: "paa";
  data: Record<string, unknown>;
} {
  return {
    tools_name: "paa",
    data: {
      queries: input.queries,
      se: 2, // Google only
      region: input.region,
      google_domain: input.google_domain ?? "www.google.ru",
      google_from: input.google_from ?? "RU",
      google_lang: input.google_lang ?? "ru",
      depth: input.depth ?? 1,
      count: input.count ?? 10,
    },
  };
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type PaaItem = { question: string; answer?: string | null; depth?: number };

function extractPaaItems(payload: unknown, seedQuery: string): PaaItem[] {
  const root = asObj(payload);
  const result = asObj(root.result);
  const inner = asObj(result.result ?? result);
  const bags: unknown[] = [];
  for (const key of ["result", "paa", "questions", "items", "answers"]) {
    const v = inner[key] ?? result[key];
    if (Array.isArray(v)) bags.push(...v);
  }
  for (const mapCandidate of [inner, result, asObj(inner.result), asObj(result.result)]) {
    if (!mapCandidate || Array.isArray(mapCandidate)) continue;
    const hit = mapCandidate[seedQuery];
    if (Array.isArray(hit)) bags.push(...hit);
    else {
      for (const v of Object.values(mapCandidate)) {
        if (Array.isArray(v)) {
          bags.push(...v);
          break;
        }
      }
    }
  }
  const out: PaaItem[] = [];
  const seen = new Set<string>();
  for (const raw of bags) {
    if (typeof raw === "string") {
      const q = raw.trim();
      if (!q || seen.has(q.toLowerCase())) continue;
      seen.add(q.toLowerCase());
      out.push({ question: q, depth: 1 });
      continue;
    }
    const o = asObj(raw);
    const question = String(o.question ?? o.q ?? o.title ?? o.text ?? "").trim();
    if (!question || seen.has(question.toLowerCase())) continue;
    seen.add(question.toLowerCase());
    out.push({
      question,
      answer: o.answer != null ? String(o.answer) : o.snippet != null ? String(o.snippet) : null,
      depth: Number(o.depth ?? o.level ?? 1) || 1,
    });
  }
  return out;
}

function syntheticPaaUrl(parentQuery: string, question: string, rank: number): string {
  const h = createHash("sha1").update(`${parentQuery}|${question}|${rank}`).digest("hex").slice(0, 12);
  return `arsenkin://paa/${h}`;
}

export function mapPaaToObservations(input: {
  caseId: string;
  auditRunId: string;
  regionLabel: string;
  language: string;
  queries: string[];
  payload: unknown;
  capturedAt?: Date;
}): SerpObservationDraft[] {
  const capturedAt = input.capturedAt ?? new Date();
  const drafts: SerpObservationDraft[] = [];
  for (const queryText of input.queries) {
    const parentQueryId = buildSerpQueryId({
      auditRunId: input.auditRunId,
      provider: "arsenkin",
      engine: "GOOGLE",
      region: input.regionLabel,
      language: input.language,
      queryText,
      surface: "organic",
    });
    const paaQueryId = buildSerpQueryId({
      auditRunId: input.auditRunId,
      provider: "arsenkin",
      engine: "GOOGLE",
      region: input.regionLabel,
      language: input.language,
      queryText,
      surface: "paa",
    });
    const items = extractPaaItems(input.payload, queryText);
    items.forEach((item, idx) => {
      const rank = idx + 1;
      drafts.push({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        queryId: paaQueryId,
        parentQueryId,
        queryText,
        provider: "arsenkin",
        engine: "GOOGLE",
        surface: "paa",
        region: input.regionLabel,
        language: input.language,
        rank,
        url: syntheticPaaUrl(queryText, item.question, rank),
        title: item.question,
        snippet: item.answer ?? null,
        domain: "paa",
        providerStatus: "OK",
        rawPayloadJson: {
          source: "arsenkin",
          tool: "paa",
          engineNote: "google-only",
          depth: item.depth ?? 1,
          question: item.question,
        },
        capturedAt,
      });
    });
  }
  return drafts;
}
