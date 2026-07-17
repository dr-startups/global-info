/**
 * Shared typed unwrap for Arsenkin /get envelopes.
 * Production Arsenkin returns `{ code, result, task_id, created_at?, finished_at? }`;
 * tool adapters consume a normalized payload (items/results/…), never the raw envelope alone.
 */

export type ArsenkinEnvelopeMeta = {
  code: string | null;
  taskId: string | null;
};

export type ArsenkinToolAdapterName =
  | "SEARCH_TOP"
  | "SUGGESTIONS"
  | "PAA"
  | "AI_SEARCH"
  | "URL_AUDIT";

export type UnwrapArsenkinEnvelopeResult =
  | {
      ok: true;
      /** Tool-facing payload after envelope strip + nested result promotion. */
      payload: Record<string, unknown>;
      envelope: ArsenkinEnvelopeMeta | null;
      /** True when top-level was a `{code,result,task_id}` envelope. */
      unwrappedEnvelope: boolean;
    }
  | {
      ok: false;
      code: "ARSENKIN_SCHEMA_INVALID";
      message: string;
    };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

const TOOL_ARRAY_KEYS = [
  "items",
  "results",
  "tops",
  "suggestions",
  "questions",
  "answers",
  "urls",
  "pages",
  "paa",
] as const;

function hasToolArray(payload: Record<string, unknown>): boolean {
  for (const k of TOOL_ARRAY_KEYS) {
    if (Array.isArray(payload[k])) return true;
  }
  return false;
}

/**
 * Promote nested Arsenkin `result` containers so tool adapters see items/results arrays.
 * Proven shapes (provider fixtures + Job B live RO):
 * - check-top: envelope.result = { result: { collect, snippets }, request }
 * - suggest: envelope.result = { types, result: { "0": string[] }, … }
 * - paa: envelope.result = { result: [[{question,…}]], … }
 * - ai-serp: envelope.result = { table: [{details,sources}], … }
 * - indexation: envelope.result = { table: [{url,yandex,google}], … }
 */
function isNestedBlockArray(v: unknown): boolean {
  return Array.isArray(v) && v.some((x) => Array.isArray(x));
}

export function promoteArsenkinToolPayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  if (hasToolArray(payload)) return payload;

  const nested = payload.result;
  // PAA (and similar) use result: [[{…}]] — do not promote nested blocks to items here.
  if (Array.isArray(nested) && !isNestedBlockArray(nested)) {
    return { ...payload, results: nested, items: nested };
  }
  if (isPlainObject(nested)) {
    if (hasToolArray(nested)) {
      return { ...payload, ...nested };
    }
    const deep = nested.result;
    if (Array.isArray(deep) && !isNestedBlockArray(deep)) {
      return { ...payload, ...nested, results: deep, items: deep };
    }
    if (isPlainObject(deep) && hasToolArray(deep)) {
      return { ...payload, ...nested, ...deep };
    }
  }
  return payload;
}

function promoteSearchTop(payload: Record<string, unknown>): Record<string, unknown> {
  if (hasToolArray(payload)) return payload;
  const wrap = isPlainObject(payload.result) ? payload.result : payload;
  const inner = isPlainObject(wrap.result) ? wrap.result : wrap;
  const collect = Array.isArray(inner.collect)
    ? (inner.collect as unknown[])
    : Array.isArray(wrap.collect)
      ? (wrap.collect as unknown[])
      : null;
  if (!collect) return promoteArsenkinToolPayload(payload);

  const snipRoot = isPlainObject(inner.snippets)
    ? inner.snippets
    : isPlainObject(wrap.snippets)
      ? wrap.snippets
      : {};
  const request = isPlainObject(payload.request)
    ? payload.request
    : isPlainObject(wrap.request)
      ? wrap.request
      : {};
  const queries = Array.isArray(request.queries)
    ? request.queries.map((q) => asString(q)).filter(Boolean)
    : [];
  const items: Record<string, unknown>[] = [];
  for (let qi = 0; qi < collect.length; qi++) {
    const perQuery = collect[qi];
    const query = queries[qi] ?? queries[0] ?? "";
    const urlBags: unknown[] = Array.isArray(perQuery) ? perQuery : [];
    for (const bag of urlBags) {
      const urls = Array.isArray(bag)
        ? bag
        : typeof bag === "string"
          ? [bag]
          : [];
      for (const u of urls) {
        const url = asString(u);
        if (!url) continue;
        const snipVal = snipRoot[url];
        const first = Array.isArray(snipVal)
          ? isPlainObject(snipVal[0])
            ? snipVal[0]
            : {}
          : isPlainObject(snipVal)
            ? snipVal
            : {};
        items.push({
          url,
          title: asString(first.title) || undefined,
          snippet: asString(first.snippet) || undefined,
          query,
        });
      }
    }
  }
  return { ...payload, items, results: items, query: queries[0] ?? "" };
}

function promoteSuggestions(payload: Record<string, unknown>): Record<string, unknown> {
  if (hasToolArray(payload)) return payload;
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
  const candidates: string[] = [];
  const types = isPlainObject(payload.types) ? payload.types : {};
  for (const phrase of Object.keys(types)) {
    if (phrase.trim()) candidates.push(phrase.trim());
  }
  const byBucket = isPlainObject(payload.result) ? payload.result : {};
  for (const v of Object.values(byBucket)) {
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string" && x.trim()) candidates.push(x.trim());
      }
    }
  }
  for (const key of ["suggestions", "items", "results", "words", "phrases"]) {
    const v = payload[key];
    if (!Array.isArray(v)) continue;
    if (v.every((x) => typeof x === "string" && OPTION_CODES.has(String(x).toLowerCase()))) {
      continue;
    }
    for (const x of v) {
      if (typeof x === "string" && x.trim()) candidates.push(x.trim());
    }
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const c of candidates) {
    const k = c.toLowerCase();
    if (!c || seen.has(k) || OPTION_CODES.has(k)) continue;
    if (/^[a-z]{1,5}$/i.test(c)) continue;
    seen.add(k);
    items.push(c);
  }
  if (items.length === 0 && !isPlainObject(payload.types) && !isPlainObject(payload.result)) {
    return promoteArsenkinToolPayload(payload);
  }
  const words = Array.isArray(payload.words) ? payload.words : [];
  const query = asString(words[0]) || asString(payload.query) || "";
  return { ...payload, items, suggestions: items, results: items, query };
}

function promotePaa(payload: Record<string, unknown>): Record<string, unknown> {
  const existing = payload.items ?? payload.questions ?? payload.results ?? payload.paa;
  // Already flat tool rows (or EMPTY_VALID []). Nested [[{…}]] needs flattening.
  if (Array.isArray(existing) && !isNestedBlockArray(existing)) {
    return payload;
  }
  const inner = payload.result ?? payload;
  const bags: unknown[] = [];
  if (Array.isArray(inner)) {
    for (const block of inner) {
      if (Array.isArray(block)) bags.push(...block);
      else bags.push(block);
    }
  } else if (isPlainObject(inner)) {
    const nested = inner.result ?? inner.paa ?? inner.questions ?? inner.items;
    if (Array.isArray(nested)) {
      for (const block of nested) {
        if (Array.isArray(block)) bags.push(...block);
        else bags.push(block);
      }
    }
  }
  if (Array.isArray(existing) && isNestedBlockArray(existing)) {
    for (const block of existing) {
      if (Array.isArray(block)) bags.push(...block);
      else bags.push(block);
    }
  }
  if (bags.length === 0) return promoteArsenkinToolPayload(payload);
  const questions: Record<string, unknown>[] = [];
  for (const raw of bags) {
    if (typeof raw === "string") {
      const question = raw.trim();
      if (question) questions.push({ question });
      continue;
    }
    if (!isPlainObject(raw)) continue;
    const question = asString(raw.question ?? raw.paa ?? raw.title ?? raw.text);
    if (question) questions.push({ ...raw, question });
  }
  const queries = Array.isArray(payload.queries) ? payload.queries : [];
  return {
    ...payload,
    items: questions,
    questions,
    results: questions,
    query: asString(queries[0]) || asString(payload.query) || "",
  };
}

function promoteAiSearch(payload: Record<string, unknown>): Record<string, unknown> {
  if (hasToolArray(payload) || asString(payload.answer ?? payload.text ?? payload.content)) {
    return payload;
  }
  const table = Array.isArray(payload.table)
    ? payload.table
    : isPlainObject(payload.result) && Array.isArray(payload.result.table)
      ? payload.result.table
      : null;
  if (!table) return promoteArsenkinToolPayload(payload);
  const items: Record<string, unknown>[] = [];
  for (const raw of table) {
    if (!isPlainObject(raw)) continue;
    const details = asString(raw.details)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const sources = Array.isArray(raw.sources) ? raw.sources : [];
    const firstSrc = sources.find((s) => isPlainObject(s) && asString(s.url));
    const url = firstSrc && isPlainObject(firstSrc) ? asString(firstSrc.url) : "";
    if (!details && !url) continue;
    items.push({
      answer: details,
      text: details,
      title: url && isPlainObject(firstSrc) ? asString(firstSrc.title) || "AI answer" : "AI answer",
      url: url || undefined,
      found: Boolean(raw.found ?? details),
    });
  }
  const queries = Array.isArray(payload.queries) ? payload.queries : [];
  // Proven empty AI table (all found=false) → empty items array (EMPTY_VALID).
  return {
    ...payload,
    items,
    answers: items,
    results: items,
    query: asString(queries[0]) || asString(payload.query) || "",
  };
}

function promoteUrlAudit(payload: Record<string, unknown>): Record<string, unknown> {
  if (hasToolArray(payload) || asString(payload.url ?? payload.link)) {
    return payload;
  }
  const table = Array.isArray(payload.table)
    ? payload.table
    : isPlainObject(payload.result) && Array.isArray(payload.result.table)
      ? payload.result.table
      : null;
  if (!table) return promoteArsenkinToolPayload(payload);
  const items: Record<string, unknown>[] = [];
  for (const raw of table) {
    if (!isPlainObject(raw)) continue;
    const url = asString(raw.url ?? raw.link);
    if (!url) continue;
    const yandex = raw.yandex;
    const google = raw.google;
    const status = [
      yandex === true ? "yandex:indexed" : yandex === false ? "yandex:missing" : null,
      google === true ? "google:indexed" : google === false ? "google:missing" : null,
    ]
      .filter(Boolean)
      .join("; ");
    items.push({ url, title: "URL audit", status, snippet: status });
  }
  return { ...payload, items, urls: items, results: items };
}

/**
 * Tool-aware normalization after envelope unwrap. Fail-closed callers treat
 * missing arrays after this step as ARSENKIN_SCHEMA_INVALID.
 */
export function normalizeArsenkinToolPayload(
  tool: ArsenkinToolAdapterName,
  payload: Record<string, unknown>
): Record<string, unknown> {
  switch (tool) {
    case "SEARCH_TOP":
      return promoteSearchTop(payload);
    case "SUGGESTIONS":
      return promoteSuggestions(payload);
    case "PAA":
      return promotePaa(payload);
    case "AI_SEARCH":
      return promoteAiSearch(payload);
    case "URL_AUDIT":
      return promoteUrlAudit(payload);
    default:
      return promoteArsenkinToolPayload(payload);
  }
}

/**
 * Unwrap a ProviderTask.responseJson from Arsenkin /get into a tool adapter payload.
 * Already-flat fixtures (items/results at top level) pass through unchanged.
 */
export function unwrapArsenkinTaskEnvelope(raw: unknown): UnwrapArsenkinEnvelopeResult {
  if (raw == null) {
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: "Arsenkin responseJson missing (null/undefined)",
    };
  }
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: "Arsenkin responseJson must be a plain object",
    };
  }

  const looksLikeEnvelope =
    Object.prototype.hasOwnProperty.call(raw, "task_id") ||
    (Object.prototype.hasOwnProperty.call(raw, "code") &&
      Object.prototype.hasOwnProperty.call(raw, "result"));

  if (!looksLikeEnvelope) {
    if (
      Object.prototype.hasOwnProperty.call(raw, "_submitDiagnostics") &&
      !hasToolArray(raw) &&
      raw.result == null &&
      raw.items == null
    ) {
      return {
        ok: false,
        code: "ARSENKIN_SCHEMA_INVALID",
        message: "Arsenkin responseJson is submit diagnostics, not a result payload",
      };
    }
    return {
      ok: true,
      payload: promoteArsenkinToolPayload(raw),
      envelope: null,
      unwrappedEnvelope: false,
    };
  }

  if (!Object.prototype.hasOwnProperty.call(raw, "result")) {
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: "Arsenkin envelope missing result field",
    };
  }

  const envelope: ArsenkinEnvelopeMeta = {
    code: raw.code == null ? null : asString(raw.code) || null,
    taskId: raw.task_id == null ? null : asString(raw.task_id) || null,
  };

  const inner = raw.result;
  let payload: Record<string, unknown>;
  if (Array.isArray(inner)) {
    payload = { results: inner, items: inner };
  } else if (isPlainObject(inner)) {
    payload = inner;
  } else if (inner == null) {
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: "Arsenkin envelope result is null",
    };
  } else {
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: `Arsenkin envelope result has unsupported type: ${typeof inner}`,
    };
  }

  return {
    ok: true,
    payload: promoteArsenkinToolPayload(payload),
    envelope,
    unwrappedEnvelope: true,
  };
}
