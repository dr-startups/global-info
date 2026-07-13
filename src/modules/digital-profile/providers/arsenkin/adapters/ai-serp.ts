/**
 * Arsenkin ai-serp → SerpObservation(surface=ai_answer).
 * Separate evidence: how search AI describes the subject — NOT a Knowledge Panel.
 *
 * API quirk: `brands` must be a non-empty array (validated server-side even for
 * subject-profile collection where brand tracking is not the goal).
 */

import { createHash } from "node:crypto";
import { domainOf } from "../../types";
import { buildSerpQueryId } from "../../../serp-observation/query-id";
import type { SerpObservationDraft } from "../../../serp-observation/types";

export type AiSerpRequestInput = {
  queries: string[];
  /** 1=Yandex Alice, 2=Google AI Overview */
  se: 1 | 2;
  region: number;
  /** Optional brand/host tracking — not required for digital-profile pilot. */
  host?: string;
  subdomain?: boolean;
  brands?: string[];
};

export function buildAiSerpRequest(input: AiSerpRequestInput): {
  tools_name: "ai-serp";
  data: Record<string, unknown>;
} {
  // Arsenkin rejects missing/empty brands with JSON_VALIDATION_ERROR.
  const brands =
    input.brands?.filter((b) => String(b).trim()).slice(0, 10) ??
    deriveDefaultBrands(input.queries);
  const data: Record<string, unknown> = {
    queries: input.queries,
    se: input.se,
    region: input.region,
    subdomain: input.subdomain ?? false,
    brands: brands.length > 0 ? brands : ["subject"],
  };
  if (input.host?.trim()) data.host = input.host.trim();
  else data.host = "example.com";
  return { tools_name: "ai-serp", data };
}

/** Pull short brand-like tokens from the query for required `brands` field. */
function deriveDefaultBrands(queries: string[]): string[] {
  const q = String(queries[0] ?? "").trim();
  if (!q) return ["subject"];
  const parts = q.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  if (parts[0]) out.push(parts[0]);
  if (parts.length >= 2) out.push(`${parts[0]} ${parts[1]}`);
  out.push(q);
  return [...new Set(out)].slice(0, 10);
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function syntheticAiUrl(query: string, engine: string, rank: number): string {
  const h = createHash("sha1").update(`${query}|${engine}|${rank}`).digest("hex").slice(0, 12);
  return `arsenkin://ai-serp/${h}`;
}

type AiBlock = {
  answerText: string;
  found: boolean;
  sources: Array<{ url: string; title: string | null; description: string | null }>;
};

function extractAiBlocks(payload: unknown): AiBlock[] {
  const root = asObj(payload);
  const result = asObj(root.result);
  const table = Array.isArray(result.table)
    ? result.table
    : Array.isArray(asObj(result.result).table)
      ? (asObj(result.result).table as unknown[])
      : [];
  const blocks: AiBlock[] = [];
  for (const raw of table) {
    const row = asObj(raw);
    const details = row.details != null ? stripHtml(String(row.details)) : "";
    const sourcesRaw = Array.isArray(row.sources) ? row.sources : [];
    const sources = sourcesRaw.map((s) => {
      const o = asObj(s);
      return {
        url: String(o.url ?? "").trim(),
        title: o.title != null ? String(o.title) : null,
        description: o.description != null ? String(o.description) : null,
      };
    });
    const found = Boolean(row.found ?? details);
    if (!details && sources.length === 0) {
      // Honest empty: Arsenkin returned a table row with found=false.
      blocks.push({ answerText: "", found: false, sources: [] });
      continue;
    }
    blocks.push({
      answerText: details,
      found,
      sources: sources.filter((s) => s.url),
    });
  }
  return blocks;
}

export function mapAiSerpToObservations(input: {
  caseId: string;
  auditRunId: string;
  regionLabel: string;
  language: string;
  queries: string[];
  se: 1 | 2;
  payload: unknown;
  capturedAt?: Date;
}): SerpObservationDraft[] {
  const capturedAt = input.capturedAt ?? new Date();
  const engine = input.se === 1 ? "YANDEX" : "GOOGLE";
  const blocks = extractAiBlocks(input.payload);
  const drafts: SerpObservationDraft[] = [];

  for (const queryText of input.queries) {
    const queryId = buildSerpQueryId({
      auditRunId: input.auditRunId,
      provider: "arsenkin",
      engine,
      region: input.regionLabel,
      language: input.language,
      queryText,
      surface: "ai_answer",
    });

    if (blocks.length === 0) {
      drafts.push({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        queryId,
        queryText,
        provider: "arsenkin",
        engine,
        surface: "ai_answer",
        region: input.regionLabel,
        language: input.language,
        rank: 1,
        url: syntheticAiUrl(queryText, engine, 1),
        title: `ИИ-ответ (${engine === "YANDEX" ? "Алиса" : "AI Overview"}): не найден`,
        snippet:
          "В выдаче нет блока поискового ИИ по запросу. Это не карточка Wikipedia и не энциклопедическая статья.",
        domain: "ai-serp",
        providerStatus: "NO_RESULTS",
        rawPayloadJson: {
          source: "arsenkin",
          tool: "ai-serp",
          engine,
          kind: "absent",
          notKnowledgePanel: true,
        },
        capturedAt,
      });
      continue;
    }

    blocks.forEach((block, bi) => {
      if (block.answerText) {
        drafts.push({
          caseId: input.caseId,
          auditRunId: input.auditRunId,
          queryId,
          queryText,
          provider: "arsenkin",
          engine,
          surface: "ai_answer",
          region: input.regionLabel,
          language: input.language,
          rank: bi * 100 + 1,
          url: syntheticAiUrl(queryText, engine, bi * 100 + 1),
          title: `ИИ-ответ (${engine === "YANDEX" ? "Алиса" : "AI Overview"}): ${queryText}`,
          snippet: block.answerText.slice(0, 1200),
          domain: "ai-serp",
          providerStatus: block.found ? "OK" : "NO_RESULTS",
          rawPayloadJson: {
            source: "arsenkin",
            tool: "ai-serp",
            engine,
            kind: "answer_text",
            notKnowledgePanel: true,
          },
          capturedAt,
        });
      } else if (!block.found) {
        drafts.push({
          caseId: input.caseId,
          auditRunId: input.auditRunId,
          queryId,
          queryText,
          provider: "arsenkin",
          engine,
          surface: "ai_answer",
          region: input.regionLabel,
          language: input.language,
          rank: bi * 100 + 1,
          url: syntheticAiUrl(queryText, engine, bi * 100 + 1),
          title: `ИИ-ответ (${engine === "YANDEX" ? "Алиса" : "AI Overview"}): не найден`,
          snippet:
            "В выдаче нет блока поискового ИИ по запросу. Это не карточка Wikipedia и не энциклопедическая статья.",
          domain: "ai-serp",
          providerStatus: "NO_RESULTS",
          rawPayloadJson: {
            source: "arsenkin",
            tool: "ai-serp",
            engine,
            kind: "absent",
            notKnowledgePanel: true,
          },
          capturedAt,
        });
      }
      block.sources.slice(0, 8).forEach((src, si) => {
        const rank = bi * 100 + 2 + si;
        drafts.push({
          caseId: input.caseId,
          auditRunId: input.auditRunId,
          queryId,
          queryText,
          provider: "arsenkin",
          engine,
          surface: "ai_answer",
          region: input.regionLabel,
          language: input.language,
          rank,
          url: src.url,
          title: src.title?.trim() || src.url,
          snippet: src.description,
          domain: domainOf(src.url),
          providerStatus: "OK",
          rawPayloadJson: {
            source: "arsenkin",
            tool: "ai-serp",
            engine,
            kind: "answer_source",
            notKnowledgePanel: true,
          },
          capturedAt,
        });
      });
    });
  }
  return drafts;
}
