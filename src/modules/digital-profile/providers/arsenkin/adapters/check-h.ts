/**
 * Arsenkin check-h (mode=url) → SerpObservation(surface=page_meta).
 * Enriches organic/risk URLs with title / description / H1.
 */

import { domainOf } from "../../types";
import { buildSerpQueryId } from "../../../serp-observation/query-id";
import type { SerpObservationDraft } from "../../../serp-observation/types";

export type CheckHRequestInput = {
  urls: string[];
  /** url mode for page enrichment; key mode reserved for later. */
  mode?: "url" | "key";
  pause?: number;
  foreign?: boolean;
};

export function buildCheckHRequest(input: CheckHRequestInput): {
  tools_name: "check-h";
  data: Record<string, unknown>;
} {
  const urls = input.urls.map((u) => String(u).trim()).filter(Boolean).slice(0, 20);
  return {
    tools_name: "check-h",
    data: {
      mode: input.mode ?? "url",
      queries: urls,
      pause: input.pause ?? 1,
      foreign: input.foreign ?? false,
    },
  };
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

type PageMetaRow = {
  url: string;
  title: string | null;
  description: string | null;
  h1: string | null;
};

function extractHeaders(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null;
  for (const h of raw) {
    const o = asObj(h);
    const i = String(o.i ?? o.level ?? "");
    if (i === "1" || i === "h1" || Number(i) === 1) {
      const v = o.value ?? o.text ?? o.header;
      if (v != null && String(v).trim()) return String(v).trim();
    }
  }
  // Sometimes headers is { "1": "...", "2": "..." }
  return null;
}

function extractPageRows(payload: unknown): PageMetaRow[] {
  const root = asObj(payload);
  const result = asObj(root.result);
  const table =
    (Array.isArray(result.table) && result.table) ||
    (Array.isArray(result.result) && result.result) ||
    (Array.isArray(asObj(result.result).table) && (asObj(result.result).table as unknown[])) ||
    (Array.isArray(root.table) && root.table) ||
    [];
  const rows: PageMetaRow[] = [];
  for (const raw of table) {
    const o = asObj(raw);
    const url = String(o.url ?? o.link ?? o.query ?? "").trim();
    if (!url) continue;
    let h1 = extractHeaders(o.headers);
    if (!h1 && o.h1 != null) h1 = String(o.h1).trim() || null;
    rows.push({
      url,
      title: o.title != null ? String(o.title).trim() || null : null,
      description: o.description != null ? String(o.description).trim() || null : null,
      h1,
    });
  }
  return rows;
}

export function mapCheckHToObservations(input: {
  caseId: string;
  auditRunId: string;
  regionLabel: string;
  language: string;
  urls: string[];
  payload: unknown;
  capturedAt?: Date;
}): SerpObservationDraft[] {
  const capturedAt = input.capturedAt ?? new Date();
  const rows = extractPageRows(input.payload);
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const drafts: SerpObservationDraft[] = [];

  for (const url of input.urls) {
    const row = byUrl.get(url) ?? rows.find((r) => r.url.includes(url) || url.includes(r.url));
    const queryId = buildSerpQueryId({
      auditRunId: input.auditRunId,
      provider: "arsenkin",
      engine: "YANDEX",
      region: input.regionLabel,
      language: input.language,
      queryText: url,
      surface: "page_meta",
    });
    const title = row?.title ?? null;
    const h1 = row?.h1 ?? null;
    const description = row?.description ?? null;
    const snippetParts = [
      h1 ? `H1: ${h1}` : null,
      description ? `Description: ${description.slice(0, 200)}` : null,
    ].filter(Boolean);
    drafts.push({
      caseId: input.caseId,
      auditRunId: input.auditRunId,
      queryId,
      queryText: url,
      provider: "arsenkin",
      engine: "YANDEX",
      surface: "page_meta",
      region: input.regionLabel,
      language: input.language,
      rank: 1,
      url: row?.url || url,
      title: title || h1 || domainOf(url),
      snippet: snippetParts.join(" · ") || null,
      domain: domainOf(row?.url || url),
      providerStatus: title || h1 || description ? "OK" : "NO_RESULTS",
      rawPayloadJson: {
        source: "arsenkin",
        tool: "check-h",
        mode: "url",
        title,
        description,
        h1,
      },
      capturedAt,
    });
  }

  if (drafts.length === 0 && rows.length > 0) {
    // Payload had rows not matching requested urls — still persist.
    rows.forEach((row, idx) => {
      const queryId = buildSerpQueryId({
        auditRunId: input.auditRunId,
        provider: "arsenkin",
        engine: "YANDEX",
        region: input.regionLabel,
        language: input.language,
        queryText: row.url,
        surface: "page_meta",
      });
      drafts.push({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        queryId,
        queryText: row.url,
        provider: "arsenkin",
        engine: "YANDEX",
        surface: "page_meta",
        region: input.regionLabel,
        language: input.language,
        rank: idx + 1,
        url: row.url,
        title: row.title || row.h1 || domainOf(row.url),
        snippet: [row.h1 ? `H1: ${row.h1}` : null, row.description?.slice(0, 200)]
          .filter(Boolean)
          .join(" · "),
        domain: domainOf(row.url),
        providerStatus: "OK",
        rawPayloadJson: {
          source: "arsenkin",
          tool: "check-h",
          mode: "url",
          title: row.title,
          description: row.description,
          h1: row.h1,
        },
        capturedAt,
      });
    });
  }

  return drafts;
}
