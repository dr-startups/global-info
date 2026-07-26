/**
 * Tool-specific Arsenkin result adapters — fail closed on unknown/corrupt schema.
 * No generic "everything → organic" fallback.
 * All responses pass through unwrapArsenkinTaskEnvelope first.
 */

import { createHash } from "node:crypto";
import { resolveRegionLabelFromArsenkinRequest } from "../providers/arsenkin/regions";
import {
  isArsenkinClientEvidenceObservation,
  type ArsenkinIngestedObservation,
} from "./arsenkin-enrichment-state";
import {
  normalizeArsenkinToolPayload,
  unwrapArsenkinTaskEnvelope,
  type ArsenkinToolAdapterName,
} from "./arsenkin-response-envelope";

export type { ArsenkinToolAdapterName };

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
      /** URL_AUDIT raw-item accounting (no silent drops). */
      rawItemCount?: number;
      emittedObservationCount?: number;
      diagnosticExcludedCount?: number;
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

function resolveObservationRegion(
  rawRegion: unknown,
  responseRegion: unknown,
  requestJson: unknown,
  fallback = "RU"
): string {
  const fromRequest = resolveRegionLabelFromArsenkinRequest(requestJson);
  if (fromRequest) return fromRequest;
  const fromRaw = resolveRegionLabelFromArsenkinRequest({ region: rawRegion });
  if (fromRaw) return fromRaw;
  const fromResponse = resolveRegionLabelFromArsenkinRequest({ region: responseRegion });
  if (fromResponse) return fromResponse;
  const s = asString(rawRegion ?? responseRegion);
  return s || fallback;
}

/**
 * Какой поисковой системе принадлежит наблюдение.
 *
 * Раньше всё, что пришло от Arsenkin, записывалось как `engine: "ARSENKIN"` —
 * то есть сохранялся поставщик данных, а не источник. Ниже по течению это
 * приходилось чинить догадкой: `engineOf` в сборщике ассетов переводил
 * `ARSENKIN` в `GOOGLE`, потому что иначе пустовал слот выдачи по ОАЭ. Под ту
 * же догадку попали и подсказки Яндекса: на живом прогоне слайд «Россия —
 * подсказки Яндекса» вышел пустым, а сами подсказки Яндекса встали на слайд
 * Google под ярлыком Google. В отчёте о должной осмотрительности неверно
 * названный источник хуже отсутствующего.
 *
 * Догадка не нужна: систему выбираем мы сами при отправке — параметром `se`
 * (1 — Яндекс, 2 — Google). Подтверждено формой ответа: у `se=1` регион
 * приходит яндексовым кодом (`213` — Москва), у `se=2` — гугловым
 * (`1011981`). Здесь это значение просто не теряется.
 */
export function resolveObservationEngine(
  response: Record<string, unknown> | undefined,
  requestJson: unknown
): "YANDEX" | "GOOGLE" | "ARSENKIN" {
  const seOf = (source: unknown): number | null => {
    if (!isPlainObject(source)) return null;
    const data = isPlainObject(source.data) ? source.data : source;
    const raw = (data as Record<string, unknown>).se;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const se = seOf(requestJson) ?? seOf(response);
  if (se === 1) return "YANDEX";
  if (se === 2) return "GOOGLE";
  // Инструмент без выбора системы (например, аудит URL) — источник назвать
  // нечем, и придумывать его нельзя.
  return "ARSENKIN";
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
  /** Prefer raw ProviderTask.responseJson for stable exactly-once hashes. */
  hashSource: unknown
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
      response: hashSource,
    }),
  };
}

function adaptSearchTop(
  response: Record<string, unknown>,
  ctx: ArsenkinAdapterContext,
  hashSource: unknown,
  requestJson?: unknown
): ArsenkinAdapterResult {
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
          surface: "organic",
          region: resolveObservationRegion(raw.region, response.region, requestJson),
          engine: "ARSENKIN",
          query,
          url: url || undefined,
          title: title || undefined,
          snippet: asString(raw.snippet ?? raw.description) || undefined,
          sourceUrlOrQuery: url || query || null,
        },
        ctx,
        "SEARCH_TOP",
        hashSource
      )
    );
  }
  return { ok: true, emptyValid: false, observations, warnings: [] };
}

function adaptSuggestions(
  response: Record<string, unknown>,
  ctx: ArsenkinAdapterContext,
  hashSource: unknown,
  requestJson?: unknown
): ArsenkinAdapterResult {
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
          surface: "autocomplete",
          region: resolveObservationRegion(
            isPlainObject(raw) ? raw.region : undefined,
            response.region,
            requestJson
          ),
          engine: resolveObservationEngine(response, requestJson),
          query,
          suggestion,
          title: suggestion,
          sourceUrlOrQuery: query || suggestion,
        },
        ctx,
        "SUGGESTIONS",
        hashSource
      )
    );
  }
  return { ok: true, emptyValid: false, observations, warnings: [] };
}

function adaptPaa(
  response: Record<string, unknown>,
  ctx: ArsenkinAdapterContext,
  hashSource: unknown,
  requestJson?: unknown
): ArsenkinAdapterResult {
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
          surface: "related",
          region: resolveObservationRegion(
            isPlainObject(raw) ? raw.region : undefined,
            response.region,
            requestJson
          ),
          engine: resolveObservationEngine(response, requestJson),
          query,
          question,
          title: question,
          sourceUrlOrQuery: query || question,
        },
        ctx,
        "PAA",
        hashSource
      )
    );
  }
  return { ok: true, emptyValid: false, observations, warnings: [] };
}

function adaptAiSearch(
  response: Record<string, unknown>,
  ctx: ArsenkinAdapterContext,
  hashSource: unknown,
  requestJson?: unknown
): ArsenkinAdapterResult {
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
              surface: "ai_answer",
              region: resolveObservationRegion(undefined, response.region, requestJson),
              engine: resolveObservationEngine(response, requestJson),
              query,
              title: asString(response.title) || "AI answer",
              snippet: answer,
              // Keep citation off the primary URL so composite does not collide with organic SERP.
              sourceUrlOrQuery: query || answer.slice(0, 120),
            },
            ctx,
            "AI_SEARCH",
            hashSource
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
  // Honest empty rows from Arsenkin table (found=false, no details) → EMPTY_VALID when all empty.
  const nonEmpty = items.filter((raw) => {
    if (!isPlainObject(raw)) return true;
    return Boolean(asString(raw.answer ?? raw.text ?? raw.content ?? raw.snippet ?? raw.url));
  });
  if (nonEmpty.length === 0) {
    return { ok: true, emptyValid: true, observations: [], warnings: ["AI_SEARCH:EMPTY_VALID"] };
  }
  const observations: ArsenkinIngestedObservation[] = [];
  for (const raw of nonEmpty.slice(0, 50)) {
    if (!isPlainObject(raw)) {
      return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "AI_SEARCH item must be object" };
    }
    const snippet = asString(raw.answer ?? raw.text ?? raw.content ?? raw.snippet);
    const title = asString(raw.title ?? "AI answer");
    if (!snippet && !title) {
      return { ok: false, code: "ARSENKIN_SCHEMA_INVALID", message: "AI_SEARCH item requires answer/text" };
    }
    const citation = asString(raw.url ?? raw.citation);
    observations.push(
      withProvenance(
        {
          kind: "other",
          surface: "ai_answer",
          region: resolveObservationRegion(raw.region, response.region, requestJson),
          engine: resolveObservationEngine(response, requestJson),
          query: asString(raw.query ?? response.query ?? ""),
          title,
          snippet: snippet || undefined,
          // Citation URLs are evidence, not the AI-row identity (avoids organic collision).
          url: snippet ? undefined : citation || undefined,
          sourceUrlOrQuery: citation || asString(raw.query ?? response.query) || null,
        },
        ctx,
        "AI_SEARCH",
        hashSource
      )
    );
  }
  return { ok: true, emptyValid: false, observations, warnings: [] };
}

function adaptUrlAudit(
  response: Record<string, unknown>,
  ctx: ArsenkinAdapterContext,
  hashSource: unknown,
  envelopeTaskId: string | null
): ArsenkinAdapterResult {
  const items = itemsArray(response, ["items", "urls", "results", "pages"]);
  const declaredRaw =
    typeof response._rawItemCount === "number" && Number.isFinite(response._rawItemCount)
      ? response._rawItemCount
      : null;

  if (items === null) {
    const url = asString(response.url ?? response.link);
    if (url) {
      const observations = [
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
            sourceIndex: 0,
            taskId: envelopeTaskId,
            clientEvidence: true,
          },
          ctx,
          "URL_AUDIT",
          hashSource
        ),
      ];
      return {
        ok: true,
        emptyValid: false,
        observations,
        warnings: [],
        rawItemCount: 1,
        emittedObservationCount: 1,
        diagnosticExcludedCount: 0,
      };
    }
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: "URL_AUDIT requires items|urls|results|pages, resp map, or url",
    };
  }
  if (items.length === 0) {
    return {
      ok: true,
      emptyValid: true,
      observations: [],
      warnings: ["URL_AUDIT:EMPTY_VALID"],
      rawItemCount: 0,
      emittedObservationCount: 0,
      diagnosticExcludedCount: 0,
    };
  }

  const rawItemCount = declaredRaw ?? items.length;
  if (rawItemCount !== items.length) {
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: `URL_AUDIT raw-item accounting mismatch: _rawItemCount=${rawItemCount} items=${items.length}`,
    };
  }

  const observations: ArsenkinIngestedObservation[] = [];
  const warnings: string[] = [];
  let emittedObservationCount = 0;
  let diagnosticExcludedCount = 0;

  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (typeof raw === "string") {
      const url = raw.trim();
      if (!/^https?:\/\//i.test(url)) {
        return {
          ok: false,
          code: "ARSENKIN_SCHEMA_INVALID",
          message: `URL_AUDIT ambiguous string item at path=items[${i}] sourceIndex=${i} (not http URL)`,
        };
      }
      observations.push(
        withProvenance(
          {
            kind: "other",
            region: asString(response.region ?? "RU") || "RU",
            engine: "ARSENKIN",
            query: asString(response.query ?? ""),
            url,
            title: "URL audit",
            sourceUrlOrQuery: url,
            sourceIndex: i,
            taskId: envelopeTaskId,
            clientEvidence: true,
          },
          ctx,
          "URL_AUDIT",
          hashSource
        )
      );
      emittedObservationCount += 1;
      continue;
    }
    if (typeof raw === "boolean") {
      // Residual boolean (should already be marked by promote) → diagnostic, never drop.
      observations.push(
        withProvenance(
          {
            kind: "URL_FETCH_STATUS",
            region: asString(response.region ?? "RU") || "RU",
            engine: "ARSENKIN",
            query: asString(response.query ?? ""),
            sourceIndex: i,
            fetchStatusValue: raw,
            diagnosticCode: "ARSENKIN_URL_FETCH_STATUS",
            exclusionReason: "check-h-boolean-slot",
            taskId: envelopeTaskId,
            clientEvidence: false,
            sourceUrlOrQuery: null,
          },
          ctx,
          "URL_AUDIT",
          hashSource
        )
      );
      diagnosticExcludedCount += 1;
      continue;
    }
    if (!isPlainObject(raw)) {
      return {
        ok: false,
        code: "ARSENKIN_SCHEMA_INVALID",
        message: `URL_AUDIT item must be object or http URL string (path=items[${i}] sourceIndex=${i} typeof=${typeof raw})`,
      };
    }
    if (raw.__schemaInvalid) {
      const path = asString(raw.path) || `items[${i}]`;
      const sourceIndex =
        typeof raw.sourceIndex === "number" && Number.isFinite(raw.sourceIndex)
          ? raw.sourceIndex
          : i;
      return {
        ok: false,
        code: "ARSENKIN_SCHEMA_INVALID",
        message: `URL_AUDIT ambiguous item at path=${path} sourceIndex=${sourceIndex}: ${asString(raw.reason) || "invalid"}`,
      };
    }
    if (raw.__urlFetchStatus === true) {
      const sourceIndex =
        typeof raw.sourceIndex === "number" && Number.isFinite(raw.sourceIndex)
          ? raw.sourceIndex
          : i;
      const value = typeof raw.value === "boolean" ? raw.value : null;
      if (value == null) {
        return {
          ok: false,
          code: "ARSENKIN_SCHEMA_INVALID",
          message: `URL_AUDIT URL_FETCH_STATUS missing boolean value at path=${asString(raw.path) || `items[${i}]`} sourceIndex=${sourceIndex}`,
        };
      }
      observations.push(
        withProvenance(
          {
            kind: "URL_FETCH_STATUS",
            region: asString(response.region ?? "RU") || "RU",
            engine: "ARSENKIN",
            query: asString(response.query ?? ""),
            sourceIndex,
            fetchStatusValue: value,
            diagnosticCode: asString(raw.diagnosticCode) || "ARSENKIN_URL_FETCH_STATUS",
            exclusionReason: asString(raw.exclusionReason) || "check-h-boolean-slot",
            taskId: envelopeTaskId,
            clientEvidence: false,
            sourceUrlOrQuery: null,
          },
          ctx,
          "URL_AUDIT",
          hashSource
        )
      );
      diagnosticExcludedCount += 1;
      continue;
    }
    const url = asString(raw.url ?? raw.link);
    if (!url) {
      return {
        ok: false,
        code: "ARSENKIN_SCHEMA_INVALID",
        message: `URL_AUDIT item requires url (path=${asString(raw.path) || `items[${i}]`} sourceIndex=${i})`,
      };
    }
    const sourceIndex =
      typeof raw.sourceIndex === "number" && Number.isFinite(raw.sourceIndex)
        ? raw.sourceIndex
        : i;
    const yandexIndexed = raw.yandex == null ? null : (raw.yandex as boolean | number);
    const googleIndexed = raw.google == null ? null : (raw.google as boolean | number);
    const indexedAt = raw.indexdate == null ? null : asString(raw.indexdate) || null;
    const yandexDoc = raw.yandex_doc == null ? null : asString(raw.yandex_doc) || null;
    observations.push(
      withProvenance(
        {
          kind: "other",
          region: asString(raw.region ?? response.region ?? "RU") || "RU",
          engine: "ARSENKIN",
          query: asString(raw.query ?? response.query ?? ""),
          url,
          title: asString(raw.title ?? raw.status ?? "URL audit"),
          snippet: asString(raw.snippet ?? raw.description ?? raw.indexation ?? raw.status) || undefined,
          sourceUrlOrQuery: url,
          sourceIndex,
          taskId: envelopeTaskId,
          clientEvidence: true,
          yandexIndexed,
          googleIndexed,
          indexedAt,
          yandexDoc,
          respMapKey: asString(raw.respMapKey) || null,
        },
        ctx,
        "URL_AUDIT",
        hashSource
      )
    );
    emittedObservationCount += 1;
  }

  if (rawItemCount !== emittedObservationCount + diagnosticExcludedCount) {
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: `URL_AUDIT accounting invariant failed: raw=${rawItemCount} emitted=${emittedObservationCount} diagnostic=${diagnosticExcludedCount}`,
    };
  }
  if (observations.length !== rawItemCount) {
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: `URL_AUDIT silent-drop detected: raw=${rawItemCount} observations=${observations.length}`,
    };
  }

  const clientCount = observations.filter(isArsenkinClientEvidenceObservation).length;
  if (clientCount !== emittedObservationCount) {
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: `URL_AUDIT clientEvidence mismatch: client=${clientCount} emitted=${emittedObservationCount}`,
    };
  }

  return {
    ok: true,
    emptyValid: clientCount === 0,
    observations,
    warnings,
    rawItemCount,
    emittedObservationCount,
    diagnosticExcludedCount,
  };
}

/**
 * Fail-closed adapter dispatch. Unknown tool / corrupt JSON → error (never silent empty).
 * Always unwraps Arsenkin `{code,result,task_id}` envelopes before tool-specific parse.
 */
export function adaptArsenkinToolResponse(input: {
  toolName: string | null | undefined;
  responseJson: unknown;
  ctx: ArsenkinAdapterContext;
  /** ProviderTask.requestJson — used to recover RU/UAE from se.region. */
  requestJson?: unknown;
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
    return {
      ok: false,
      code: "ARSENKIN_SCHEMA_INVALID",
      message: `${adapter}: missing responseJson (parse error ≠ empty)`,
    };
  }

  const unwrapped = unwrapArsenkinTaskEnvelope(input.responseJson);
  if (!unwrapped.ok) {
    return { ok: false, code: unwrapped.code, message: `${adapter}: ${unwrapped.message}` };
  }

  const payload = normalizeArsenkinToolPayload(adapter, unwrapped.payload);
  const warnings: string[] = [];
  if (unwrapped.unwrappedEnvelope) {
    warnings.push("arsenkin-envelope-unwrapped");
  }
  const hashSource = input.responseJson;
  const envelopeTaskId = unwrapped.envelope?.taskId ?? null;

  let adapted: ArsenkinAdapterResult;
  switch (adapter) {
    case "SEARCH_TOP":
      adapted = adaptSearchTop(payload, input.ctx, hashSource, input.requestJson);
      break;
    case "SUGGESTIONS":
      adapted = adaptSuggestions(payload, input.ctx, hashSource, input.requestJson);
      break;
    case "PAA":
      adapted = adaptPaa(payload, input.ctx, hashSource, input.requestJson);
      break;
    case "AI_SEARCH":
      adapted = adaptAiSearch(payload, input.ctx, hashSource, input.requestJson);
      break;
    case "URL_AUDIT":
      adapted = adaptUrlAudit(payload, input.ctx, hashSource, envelopeTaskId);
      break;
    default:
      return { ok: false, code: "ARSENKIN_UNKNOWN_TOOL", message: `unhandled adapter ${adapter}` };
  }
  if (!adapted.ok) return adapted;
  return {
    ok: true,
    emptyValid: adapted.emptyValid,
    observations: adapted.observations,
    warnings: [...warnings, ...adapted.warnings],
    rawItemCount: adapted.rawItemCount,
    emittedObservationCount: adapted.emittedObservationCount,
    diagnosticExcludedCount: adapted.diagnosticExcludedCount,
  };
}
