/**
 * Arsenkin indexation → SerpObservation(surface=indexation).
 * Checks whether URLs are indexed in Yandex / Google.
 */

import { domainOf } from "../../types";
import { buildSerpQueryId } from "../../../serp-observation/query-id";
import type { SerpObservationDraft } from "../../../serp-observation/types";

export type IndexationRequestInput = {
  urls: string[];
  yandex?: boolean;
  google?: boolean;
  search_all?: boolean;
  inurl?: boolean;
};

export function buildIndexationRequest(input: IndexationRequestInput): {
  tools_name: "indexation";
  data: Record<string, unknown>;
} {
  const urls = input.urls.map((u) => String(u).trim()).filter(Boolean).slice(0, 20);
  return {
    tools_name: "indexation",
    data: {
      queries: urls,
      yandex: input.yandex ?? true,
      google: input.google ?? true,
      search_all: input.search_all ?? true,
      inurl: input.inurl ?? true,
    },
  };
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function truthyIndex(v: unknown): boolean | null {
  if (v === true || v === 1 || v === "1" || v === "true" || v === "yes") return true;
  if (v === false || v === 0 || v === "0" || v === "false" || v === "no") return false;
  if (typeof v === "string") {
    const s = v.toLowerCase();
    if (/индекс|indexed|да|yes|found/.test(s) && !/не\s*индекс|not\s*index|нет|absent/.test(s)) {
      return true;
    }
    if (/не\s*индекс|not\s*index|нет|absent|missing/.test(s)) return false;
  }
  return null;
}

type IndexRow = {
  url: string;
  yandex: boolean | null;
  google: boolean | null;
};

function extractIndexRows(payload: unknown): IndexRow[] {
  const root = asObj(payload);
  const result = asObj(root.result);
  const table =
    (Array.isArray(result.table) && result.table) ||
    (Array.isArray(result.result) && result.result) ||
    (Array.isArray(asObj(result.result).table) && (asObj(result.result).table as unknown[])) ||
    (Array.isArray(root.table) && root.table) ||
    [];
  const rows: IndexRow[] = [];
  for (const raw of table) {
    const o = asObj(raw);
    const url = String(o.url ?? o.link ?? o.query ?? "").trim();
    if (!url) continue;
    rows.push({
      url,
      yandex: truthyIndex(o.yandex ?? o.ya ?? o.yndex ?? o.yandex_index),
      google: truthyIndex(o.google ?? o.g ?? o.google_index),
    });
  }
  // Map form: result.urls[url] = { yandex, google }
  const urlsMap = asObj(result.urls ?? result.index ?? asObj(result.result).urls);
  for (const [url, val] of Object.entries(urlsMap)) {
    if (!String(url).startsWith("http")) continue;
    const o = asObj(val);
    rows.push({
      url,
      yandex: truthyIndex(o.yandex ?? o.ya ?? val),
      google: truthyIndex(o.google ?? o.g),
    });
  }
  return rows;
}

function labelIndex(v: boolean | null): string {
  if (v === true) return "в индексе";
  if (v === false) return "не в индексе";
  return "н/д";
}

export function mapIndexationToObservations(input: {
  caseId: string;
  auditRunId: string;
  regionLabel: string;
  language: string;
  urls: string[];
  payload: unknown;
  capturedAt?: Date;
}): SerpObservationDraft[] {
  const capturedAt = input.capturedAt ?? new Date();
  const rows = extractIndexRows(input.payload);
  const byUrl = new Map(rows.map((r) => [r.url, r]));
  const drafts: SerpObservationDraft[] = [];

  for (const url of input.urls) {
    const row =
      byUrl.get(url) ??
      rows.find((r) => r.url.replace(/\/$/, "") === url.replace(/\/$/, "")) ??
      rows.find((r) => r.url.includes(url) || url.includes(r.url));
    const yandex = row?.yandex ?? null;
    const google = row?.google ?? null;
    for (const [engine, indexed] of [
      ["YANDEX", yandex],
      ["GOOGLE", google],
    ] as const) {
      const queryId = buildSerpQueryId({
        auditRunId: input.auditRunId,
        provider: "arsenkin",
        engine,
        region: input.regionLabel,
        language: input.language,
        queryText: url,
        surface: "indexation",
      });
      drafts.push({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        queryId,
        queryText: url,
        provider: "arsenkin",
        engine,
        surface: "indexation",
        region: input.regionLabel,
        language: input.language,
        rank: 1,
        url: row?.url || url,
        title: `${domainOf(url)} · ${engine}: ${labelIndex(indexed)}`,
        snippet: `Индексация URL в ${engine}: ${labelIndex(indexed)}`,
        domain: domainOf(row?.url || url),
        providerStatus: indexed != null ? "OK" : "NO_RESULTS",
        rawPayloadJson: { source: "arsenkin", tool: "indexation", engine, indexed },
        capturedAt,
      });
    }
  }
  return drafts;
}
