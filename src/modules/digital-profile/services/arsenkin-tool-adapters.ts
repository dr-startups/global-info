/**
 * Tool-specific Arsenkin result adapters — fail closed on unknown/corrupt schema.
 * No generic "everything → organic" fallback.
 */

import { createHash } from "node:crypto";
import type { ArsenkinIngestedObservation } from "./arsenkin-enrichment-state";

export type ArsenkinToolAdapterName =
  | "SEARCH_TOP"
  | "SUGGESTIONS"
  | "PAA"
  | "AI_SEARCH"
  | "URL_AUDIT";

export type ArsenkinAdapterContext = {
  caseAgent: string;
  toolName: string;
  externalTaskId: string | null;
  enrichmentRunId: string;
  unifiedJobId: string;
  providerTaskId: string;
};

export type ArsenkinAdapterResult =
  | {
      ok: true;
      emptyValid: boolean;
      observations: ArsenkinIngestedObservation[];
      warnings: string[];
    }
  | {
      ok: false;
      code: "ARSENKIN_SCHEMA_INVALID" | "ARSENKIN_UNKNOWN_TOOL" | "ARSENKIN_PARSE_ERROR";
      message: string;
    };

export function fullArsenkinResultHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function itemsArray(response: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const k of keys) {
    const v = response[k];
    if (Array.isArray(v)) return v;
  }
  return null;
}

export function resolveToolAdapterName(toolName: string | null | undefined): ArsenkinToolAdapterName | null {
  const t = String(toolName ?? "")
    .trim()
    .toLowerCase();
  if (t === "check-top" || t === "search-top" || t === "search_top") return "SEARCH_TOP";
  if (t === "suggest" || t === "suggestions") return "SUGGESTIONS";
  if (t === "paa") return "PAA";
  if (t === "ai-serp" || t === "ai_serp" || t === "ai-search") return "AI_SEARCH";
  if (t === "check-h" || t === "indexation" || t === "url-audit" || t === "url_audit") return "URL_AUDIT";
  return null;
}

/**
 * Task-level resultHash (full response) — shared by all rows from one externalTaskId.
 * Exactly-once conflict detection keys on this hash, not per-item content.
 */
function withProvenance(
  base: Omit<ArsenkinIngestedObservation, "resultHash" | "caseAgent" | "tool" | "enrichmentRunId" | "unifiedJobId" | "externalTaskId" | "providerTaskId">,
  ctx: ArsenkinAdapterContext,
  tool: ArsenkinToolAdapterName,
  response: Record<string, unknown>
): ArsenkinIngestedObservation {
  return {
    ...base,
    providerTaskId: ctx.providerTaskId,
    externalTaskId: ctx.externalTaskId,
    caseAgent: ctx.caseAgent,
    tool: ctx.toolName,
    enrichmentRunId: ctx.enrichmentRunId,
    unifiedJobId: ctx.unifiedJobId,
    resultHash: fullArsenkinResultHash({
      tool,
      externalTaskId: ctx.externalTaskId,
      response,
    }),
  };
}

function adaptSearchTop(response: Record<string, unknown>, ctx: ArsenkinAdapterContext): ArsenkinAdapterResult {
  const items = itemsArray(response, ["items", "results", "tops"]);
  if (items === null) {
    return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "SEARCH_TOP requires items|results|tops array" };
  }
  if (items.length === 0) {
    return { ok: true, emptyValid: true, observations: [], warnings: ["SEARCH_TOP:EMPTY_VALID"] };
  }
  const observations: ArsenkinIngestedObservation[] = [];
  for (const raw of items.slice(0, 50)) {
    if (!isPlainObject(raw)) {
      return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "SEARCH_TOP item must be object" };
    }
    const url = asString(raw.url ?? raw.link);
    const title = asString(raw.title ?? raw.name);
    if (!url && !title) {
      return {
        ok: false,
        code: "ARSENKIN_SCHEMA_INVALID",
        message: "SEARCH_TOP item requires url or title",
      };
    }
    const query = asString(raw.query ?? response.query ?? "");
    observations.push(
      withProvenance(
        {
          kind: "organic",
          region: asString(raw.region ?? response.region ?? "RU") || "RU",
          engine: "ARSENKIN",
          query,
          url: url || undefined,
          title: title || undefined,
          snippet: asString(raw.snippet ?? raw.description) || undefined,
          sourceUrlOrQuery: url || query || null,
        },
        ctx,
        "SEARCH_TOP",
        response
      )
    );
  }
  return { ok: true, emptyValid: false, observations, warnings: [] };
}

function adaptSuggestions(response: Record<string, unknown>, ctx: ArsenkinAdapterContext): ArsenkinAdapterResult {
  const items = itemsArray(response, ["items", "suggestions", "results"]);
  if (items === null) {
    return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "SUGGESTIONS requires items|suggestions|results array" };
  }
  if (items.length === 0) {
    return { ok: true, emptyValid: true, observations: [], warnings: ["SUGGESTIONS:EMPTY_VALID"] };
  }
  const observations: ArsenkinIngestedObservation[] = [];
  const query = asString(response.query ?? "");
  for (const raw of items.slice(0, 50)) {
    const suggestion =
      typeof raw === "string" ? raw.trim() : isPlainObject(raw) ? asString(raw.suggestion ?? raw.text ?? raw.title) : "";
    if (!suggestion) {
      return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "SUGGESTIONS item requires suggestion text" };
    }
    observations.push(
      withProvenance(
        {
          kind: "suggestion",
          region: asString(isPlainObject(raw) ? raw.region : response.region) || "RU",
          engine: "ARSENKIN",
          query,
          suggestion,
          title: suggestion,
          sourceUrlOrQuery: query || suggestion,
        },
        ctx,
        "SUGGESTIONS",
        response
      )
    );
  }
  return { ok: true, emptyValid: false, observations, warnings: [] };
}

function adaptPaa(response: Record<string, unknown>, ctx: ArsenkinAdapterContext): ArsenkinAdapterResult {
  const items = itemsArray(response, ["items", "questions", "results", "paa"]);
  if (items === null) {
    return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "PAA requires items|questions|results|paa array" };
  }
  if (items.length === 0) {
    return { ok: true, emptyValid: true, observations: [], warnings: ["PAA:EMPTY_VALID"] };
  }
  const observations: ArsenkinIngestedObservation[] = [];
  const query = asString(response.query ?? "");
  for (const raw of items.slice(0, 50)) {
    if (!isPlainObject(raw) && typeof raw !== "string") {
      return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "PAA item must be object or string" };
    }
    const question =
      typeof raw === "string" ? raw.trim() : asString(raw.question ?? raw.paa ?? raw.title ?? raw.text);
    if (!question) {
      return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "PAA item requires question" };
    }
    observations.push(
      withProvenance(
        {
          kind: "paa",
          region: asString(isPlainObject(raw) ? raw.region : response.region) || "RU",
          engine: "ARSENKIN",
          query,
          question,
          title: question,
          sourceUrlOrQuery: query || question,
        },
        ctx,
        "PAA",
        response
      )
    );
  }
  return { ok: true, emptyValid: false, observations, warnings: [] };
}

function adaptAiSearch(response: Record<string, unknown>, ctx: ArsenkinAdapterContext): ArsenkinAdapterResult {
  const items = itemsArray(response, ["items", "answers", "results"]);
  if (items === null) {
    // Single answer object
    if (asString(response.answer ?? response.text ?? response.content)) {
      const answer = asString(response.answer ?? response.text ?? response.content);
      const query = asString(response.query ?? "");
      return {
        ok: true,
        emptyValid: false,
        observations: [
          withProvenance(
            {
              kind: "other",
              region: asString(response.region ?? "RU") || "RU",
              engine: "ARSENKIN",
              query,
              title: asString(response.title) || "AI answer",
              snippet: answer,
              sourceUrlOrQuery: query || answer.slice(0, 120),
            },
            ctx,
            "AI_SEARCH",
            response
          ),
        ],
        warnings: [],
      };
    }
    return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "AI_SEARCH requires items|answers|results or answer" };
  }
  if (items.length === 0) {
    return { ok: true, emptyValid: true, observations: [], warnings: ["AI_SEARCH:EMPTY_VALID"] };
  }
  const observations: ArsenkinIngestedObservation[] = [];
  for (const raw of items.slice(0, 50)) {
    if (!isPlainObject(raw)) {
      return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "AI_SEARCH item must be object" };
    }
    const snippet = asString(raw.answer ?? raw.text ?? raw.content ?? raw.snippet);
    const title = asString(raw.title ?? "AI answer");
    if (!snippet && !title) {
      return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "AI_SEARCH item requires answer/text" };
    }
    observations.push(
      withProvenance(
        {
          kind: "other",
          region: asString(raw.region ?? response.region ?? "RU") || "RU",
          engine: "ARSENKIN",
          query: asString(raw.query ?? response.query ?? ""),
          title,
          snippet: snippet || undefined,
          url: asString(raw.url ?? raw.citation) || undefined,
          sourceUrlOrQuery: asString(raw.url ?? raw.citation ?? raw.query ?? response.query) || null,
        },
        ctx,
        "AI_SEARCH",
        response
      )
    );
  }
  return { ok: true, emptyValid: false, observations, warnings: [] };
}

function adaptUrlAudit(response: Record<string, unknown>, ctx: ArsenkinAdapterContext): ArsenkinAdapterResult {
  const items = itemsArray(response, ["items", "urls", "results", "pages"]);
  if (items === null) {
    const url = asString(response.url ?? response.link);
    if (url) {
      return {
        ok: true,
        emptyValid: false,
        observations: [
          withProvenance(
            {
              kind: "other",
              region: asString(response.region ?? "RU") || "RU",
              engine: "ARSENKIN",
              query: asString(response.query ?? ""),
              url,
              title: asString(response.title ?? response.status ?? "URL audit"),
              snippet: asString(response.snippet ?? response.indexation ?? response.status) || undefined,
              sourceUrlOrQuery: url,
            },
            ctx,
            "URL_AUDIT",
            response
          ),
        ],
        warnings: [],
      };
    }
    return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "URL_AUDIT requires items|urls|results|pages or url" };
  }
  if (items.length === 0) {
    return { ok: true, emptyValid: true, observations: [], warnings: ["URL_AUDIT:EMPTY_VALID"] };
  }
  const observations: ArsenkinIngestedObservation[] = [];
  for (const raw of items.slice(0, 50)) {
    if (!isPlainObject(raw)) {
      return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "URL_AUDIT item must be object" };
    }
    const url = asString(raw.url ?? raw.link);
    if (!url) {
      return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "URL_AUDIT item requires url" };
    }
    observations.push(
      withProvenance(
        {
          kind: "other",
          region: asString(raw.region ?? response.region ?? "RU") || "RU",
          engine: "ARSENKIN",
          query: asString(raw.query ?? response.query ?? ""),
          url,
          title: asString(raw.title ?? raw.status ?? "URL audit"),
          snippet: asString(raw.snippet ?? raw.indexation ?? raw.status) || undefined,
          sourceUrlOrQuery: url,
        },
        ctx,
        "URL_AUDIT",
        response
      )
    );
  }
  return { ok: true, emptyValid: false, observations, warnings: [] };
}

/**
 * Fail-closed adapter dispatch. Unknown tool / corrupt JSON → error (never silent empty).
 */
export function adaptArsenkinToolResponse(input: {
  toolName: string | null | undefined;
  responseJson: unknown;
  ctx: ArsenkinAdapterContext;
}): ArsenkinAdapterResult {
  const adapter = resolveToolAdapterName(input.toolName);
  if (!adapter) {
    return {
      ok: false,
      code: "ARSENKIN_UNKNOWN_TOOL",
      message: `unknown Arsenkin tool schema: ${String(input.toolName ?? "")}`,
    };
  }
  if (input.responseJson == null) {
    // Explicit null/undefined after DONE is EMPTY_VALID only when schema allows empty container —
    // without a container we fail closed (cannot prove EMPTY_VALID).
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: `${adapter}: missing responseJson (parse error ≠ empty)`,
    };
  }
  if (!isPlainObject(input.responseJson)) {
    return {
      ok: false,
      code: "ARSENKIN_PARSE_ERROR",
      message: `${adapter}: responseJson must be object`,
    };
  }
  switch (adapter) {
    case "SEARCH_TOP":
      return adaptSearchTop(input.responseJson, input.ctx);
    case "SUGGESTIONS":
      return adaptSuggestions(input.responseJson, input.ctx);
    case "PAA":
      return adaptPaa(input.responseJson, input.ctx);
    case "AI_SEARCH":
      return adaptAiSearch(input.responseJson, input.ctx);
    case "URL_AUDIT":
      return adaptUrlAudit(input.responseJson, input.ctx);
    default:
      return { ok: false, code: "ARSENKIN_UNKNOWN_TOOL", message: `unhandled adapter ${adapter}` };
  }
}
