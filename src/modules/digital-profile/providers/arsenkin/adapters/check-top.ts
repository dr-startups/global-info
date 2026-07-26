/**
 * Arsenkin check-top → SerpObservation(surface=organic).
 */

import { domainOf } from "../../types";
import { buildSerpQueryId } from "../../../serp-observation/query-id";
import type { SerpObservationDraft } from "../../../serp-observation/types";
import { seTypeToEngine, type ArsenkinSeType } from "../regions";

export type CheckTopRequestInput = {
  queries: string[];
  se: Array<{ type: ArsenkinSeType | number; region: number }>;
  depth?: 5 | 10 | 20 | 30 | 50 | 100;
  is_snippet?: boolean;
  noreask?: boolean;
};

export function buildCheckTopRequest(input: CheckTopRequestInput): {
  tools_name: "check-top";
  data: Record<string, unknown>;
} {
  return {
    tools_name: "check-top",
    data: {
      queries: input.queries,
      se: input.se.map((s) => ({ type: s.type, region: s.region })),
      depth: input.depth ?? 10,
      is_snippet: input.is_snippet ?? true,
      noreask: input.noreask ?? false,
    },
  };
}

type SnippetEntry = { title?: string; snippet?: string };

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function snippetMap(raw: unknown): Map<string, SnippetEntry> {
  const out = new Map<string, SnippetEntry>();
  const root = asObj(raw);
  const snip = asObj(root.snippets ?? asObj(root.result).snippets);
  for (const [url, val] of Object.entries(snip)) {
    const first = Array.isArray(val) ? asObj(val[0]) : asObj(val);
    out.set(url, {
      title: first.title != null ? String(first.title) : undefined,
      snippet: first.snippet != null ? String(first.snippet) : undefined,
    });
  }
  return out;
}

/**
 * Map Arsenkin check-top getTask payload → observation drafts.
 * collect[queryIndex][seIndex] = url[].
 */
export function mapCheckTopToObservations(input: {
  caseId: string;
  auditRunId: string;
  /** Logical ORION region label (RU/UAE), not Arsenkin numeric id. */
  regionLabel: string;
  language: string;
  queries: string[];
  se: Array<{ type: number; region: number }>;
  payload: unknown;
  capturedAt?: Date;
}): SerpObservationDraft[] {
  const capturedAt = input.capturedAt ?? new Date();
  const root = asObj(input.payload);
  const resultWrap = asObj(root.result);
  const inner = asObj(resultWrap.result ?? resultWrap);
  const collect = Array.isArray(inner.collect)
    ? (inner.collect as unknown[][])
    : Array.isArray(resultWrap.collect)
      ? (resultWrap.collect as unknown[][])
      : [];
  const snippets = snippetMap(inner.snippets ? { snippets: inner.snippets } : resultWrap);

  const drafts: SerpObservationDraft[] = [];
  for (let qi = 0; qi < input.queries.length; qi++) {
    const queryText = input.queries[qi]!;
    const perQuery = Array.isArray(collect[qi]) ? (collect[qi] as unknown[]) : [];
    for (let si = 0; si < input.se.length; si++) {
      const se = input.se[si]!;
      const engine = seTypeToEngine(se.type);
      const urls = Array.isArray(perQuery[si])
        ? (perQuery[si] as unknown[]).map((u) => String(u ?? "").trim()).filter(Boolean)
        : // Some payloads flatten to collect[query][rank] when single SE
          typeof perQuery[0] === "string"
          ? perQuery.map((u) => String(u ?? "").trim()).filter(Boolean)
          : [];
      if (urls.length === 0 && Array.isArray(perQuery[0]) === false && si === 0) {
        // already handled flatten case
      }
      const queryId = buildSerpQueryId({
        auditRunId: input.auditRunId,
        provider: "arsenkin",
        engine,
        region: input.regionLabel,
        language: input.language,
        queryText,
        surface: "organic",
      });
      urls.forEach((url, idx) => {
        const sn = snippets.get(url);
        drafts.push({
          caseId: input.caseId,
          auditRunId: input.auditRunId,
          queryId,
          queryText,
          provider: "arsenkin",
          engine,
          surface: "organic",
          region: input.regionLabel,
          language: input.language,
          rank: idx + 1,
          url,
          title: sn?.title?.trim() ? sn.title : null,
          snippet: sn?.snippet?.trim() ? sn.snippet : null,
          domain: domainOf(url),
          providerStatus: "OK",
          rawPayloadJson: {
            source: "arsenkin",
            tool: "check-top",
            seType: se.type,
            arsenkinRegionId: se.region,
            rank: idx + 1,
          },
          capturedAt,
        });
      });
    }
  }
  return drafts;
}
