/**
 * Classify Arsenkin mapped results for coverage / UI semantics.
 * MEASURED | NO_RESULTS | FAILED_PARSE | RESULT_FETCH_FAILED
 */

import type { SerpObservationDraft } from "../../serp-observation/types";

export type ArsenkinParseOutcome =
  | "MEASURED"
  | "NO_RESULTS"
  | "FAILED_PARSE"
  | "RESULT_FETCH_FAILED";

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** True when payload looks like a successful empty Arsenkin result envelope. */
export function isValidEmptyArsenkinPayload(tool: string, payload: unknown): boolean {
  const root = asObj(payload);
  const resultWrap = asObj(root.result);
  const inner = asObj(resultWrap.result ?? resultWrap);

  if (tool === "check-top") {
    const collect = Array.isArray(inner.collect)
      ? (inner.collect as unknown[])
      : Array.isArray(resultWrap.collect)
        ? (resultWrap.collect as unknown[])
        : null;
    if (!collect) return false;
    // Valid empty: collect present but no URLs
    for (const perQuery of collect) {
      if (!Array.isArray(perQuery)) continue;
      for (const cell of perQuery) {
        if (Array.isArray(cell) && cell.some((u) => String(u ?? "").trim())) return false;
        if (typeof cell === "string" && cell.trim()) return false;
      }
    }
    return true;
  }

  if (tool === "paa") {
    const bags = resultWrap.result ?? inner.result ?? resultWrap;
    if (bags == null) return true;
    if (Array.isArray(bags)) {
      const flat = bags.flatMap((b) => (Array.isArray(b) ? b : [b]));
      return flat.every((item) => {
        if (item == null) return true;
        if (typeof item === "string") return !item.trim();
        const o = asObj(item);
        return !String(o.question ?? o.q ?? o.title ?? "").trim();
      });
    }
    return false;
  }

  if (tool === "suggest") {
    const suggest = inner.suggest ?? resultWrap.suggest ?? root.suggest;
    if (suggest == null) return true;
    if (Array.isArray(suggest)) return suggest.length === 0;
    if (typeof suggest === "object") {
      return Object.values(asObj(suggest)).every((v) => !Array.isArray(v) || v.length === 0);
    }
    return false;
  }

  // Generic: empty object / empty arrays under result
  if (Object.keys(root).length === 0) return true;
  return false;
}

/** True when payload has substantial content that adapters should parse. */
export function hasNonEmptyArsenkinPayload(tool: string, payload: unknown): boolean {
  if (payload == null) return false;
  if (isValidEmptyArsenkinPayload(tool, payload)) return false;
  const text = JSON.stringify(payload);
  if (text.length < 8) return false;
  const root = asObj(payload);
  if (root.result == null && root.collect == null && root.suggest == null) {
    // Unknown envelope with only metadata — treat as nonempty if large enough
    return text.length > 40;
  }
  return true;
}

export function okObservationCount(drafts: SerpObservationDraft[]): number {
  return drafts.filter((d) => d.providerStatus === "OK").length;
}

/** Drop synthetic absent placeholders (PAA kind:absent) from persist set. */
export function filterPersistableObservations(drafts: SerpObservationDraft[]): SerpObservationDraft[] {
  return drafts.filter((d) => {
    if (d.providerStatus === "NO_RESULTS") return false;
    const raw = d.rawPayloadJson as Record<string, unknown> | null | undefined;
    if (raw && String(raw.kind ?? "") === "absent") return false;
    return true;
  });
}

export function classifyMappedArsenkinResult(input: {
  tool: string;
  payload: unknown;
  drafts: SerpObservationDraft[];
  fetchFailed?: boolean;
}): ArsenkinParseOutcome {
  if (input.fetchFailed) return "RESULT_FETCH_FAILED";
  const ok = okObservationCount(input.drafts);
  if (ok > 0) return "MEASURED";
  if (isValidEmptyArsenkinPayload(input.tool, input.payload)) return "NO_RESULTS";
  if (hasNonEmptyArsenkinPayload(input.tool, input.payload)) return "FAILED_PARSE";
  return "NO_RESULTS";
}

export function coverageStatusForOutcome(outcome: ArsenkinParseOutcome): {
  status: string;
  resultCount: number;
  errorCode: string | null;
} {
  switch (outcome) {
    case "MEASURED":
      return { status: "OK", resultCount: 1, errorCode: null };
    case "NO_RESULTS":
      return { status: "NO_RESULTS", resultCount: 0, errorCode: null };
    case "FAILED_PARSE":
      return { status: "FAILED_PARSE", resultCount: 0, errorCode: "failed_parse" };
    case "RESULT_FETCH_FAILED":
      return { status: "RESULT_FETCH_FAILED", resultCount: 0, errorCode: "result_fetch_failed" };
  }
}
