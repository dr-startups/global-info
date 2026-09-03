/**
 * Позиции Topvisor: запуск проверки, её статус и снимок выдачи → наблюдения.
 *
 * Снимок (`get/snapshots_2/history`) — единственное место, где лежит сама
 * выдача: `positions_2/history` отвечает «где стоит сайт проекта», и для
 * служебного `example.org` это всегда «--». Ключ записи снимка —
 * `дата:позиция:индексРегиона`; номер берётся из него, а не из порядка
 * элементов, и индекс региона в ключе сверяется с запрошенным: два региона
 * Google с одной фразой различаются только им.
 *
 * Все формы запросов здесь названы самим сервисом отказами на пилоте T0, а не
 * угаданы по документации.
 */

import { createHash } from "node:crypto";
import type { ArsenkinIngestedObservation } from "../../../services/arsenkin-enrichment-state";
import { topvisorProviderName, type TopvisorAuditRegion } from "../regions";

/** Строка Topvisor в форме наблюдения обогащения — той же, что у Arsenkin. */
export type TopvisorObservation = ArsenkinIngestedObservation & {
  /** Дата снимка — ISO-день из ключа записи. */
  collectedAt?: string;
};

export type SnapshotProvenance = {
  caseId: string;
  unifiedJobId: string;
  enrichmentRunId: string;
  providerTaskId: string | null;
  externalTaskId: string | null;
};

const SNAPSHOT_KEY_RE = /^(\d{4}-\d{2}-\d{2}):(\d+):(\d+)$/;

export function parseSnapshotKey(key: string): { date: string; rank: number; regionIndex: number } | null {
  const m = SNAPSHOT_KEY_RE.exec(String(key ?? "").trim());
  if (!m) return null;
  return { date: m[1]!, rank: Number(m[2]), regionIndex: Number(m[3]) };
}

const POSITIONS_KEY_RE = /^(\d{4}-\d{2}-\d{2}):(\d+):(\d+)$/;

/**
 * Ключ истории позиций — **не** ключ снимка.
 *
 * У снимка это `дата:позиция:индексРегиона`, у позиций —
 * `дата:идентификаторПроекта:индексРегиона`. На глаз формы неотличимы, и
 * перепутать их значит принять номер проекта за место в выдаче.
 */
export function parsePositionsKey(
  key: string
): { date: string; projectId: number; regionIndex: number } | null {
  const m = POSITIONS_KEY_RE.exec(String(key ?? "").trim());
  if (!m) return null;
  return { date: m[1]!, projectId: Number(m[2]), regionIndex: Number(m[3]) };
}

/** Запрос истории позиций: AI-ответы приходят в признаках выдачи. */
export function positionsHistoryPayload(
  projectId: number,
  regionIndexes: readonly number[],
  date: string
): Record<string, unknown> {
  return {
    project_id: projectId,
    date1: date,
    date2: date,
    regions_indexes: [...regionIndexes],
    show_serp_features: 1,
    history_fields: ["position", "serp_features", "snippet_title", "snippet_body"],
  };
}

/** Разметка Topvisor (`<b>`, `<br>`) снимается: в отчёт идёт текст. */
export function stripTopvisorHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Фраза в форме, в которой её хранит Topvisor: строчными, с одним пробелом.
 * Сопоставление наших запросов с фразами проекта идёт только через неё —
 * в отчёт при этом уходит **наше** написание.
 */
export function normalizeKeyword(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

type SnapshotRecord = {
  url?: unknown;
  domain?: unknown;
  snippet_title?: unknown;
  snippet_body?: unknown;
  snippet_ext?: unknown;
};

type SnapshotBody = {
  result?: {
    keywords?: Array<{ name?: unknown; snapshotsData?: Record<string, SnapshotRecord> }>;
  } | null;
};

export function snapshotToObservations(input: {
  body: unknown;
  region: TopvisorAuditRegion;
  regionIndex: number;
  /** Запросы этого региона в нашем написании. */
  queries: readonly string[];
  /** ТОП-N: снимок Яндекса приходит на 50 при любом `depth_positions`. */
  depth: number;
  provenance: SnapshotProvenance;
}): {
  observations: TopvisorObservation[];
  matchedKeywords: number;
  unmatchedKeywords: string[];
  warnings: string[];
} {
  const byNormalized = new Map<string, string>();
  for (const q of input.queries) byNormalized.set(normalizeKeyword(q), q);

  const observations: TopvisorObservation[] = [];
  const unmatchedKeywords: string[] = [];
  const warnings: string[] = [];
  let matchedKeywords = 0;
  let mismatched = 0;

  const keywords = (input.body as SnapshotBody | null)?.result?.keywords ?? [];
  for (const kw of keywords) {
    const name = normalizeKeyword(typeof kw.name === "string" ? kw.name : "");
    const ourQuery = byNormalized.get(name);
    if (!ourQuery) {
      // Проект проверяет все фразы во всех регионах; фраза другого региона —
      // не строка этого отчёта, а издержка одного проекта на кейс.
      if (name) unmatchedKeywords.push(name);
      continue;
    }
    matchedKeywords += 1;
    for (const [key, record] of Object.entries(kw.snapshotsData ?? {})) {
      const parsed = parseSnapshotKey(key);
      if (!parsed) {
        warnings.push(`snapshot-key-unparsed:${key}`);
        continue;
      }
      if (parsed.regionIndex !== input.regionIndex) {
        mismatched += 1;
        continue;
      }
      if (parsed.rank < 1 || parsed.rank > input.depth) continue;
      const url = typeof record.url === "string" ? record.url.trim() : "";
      if (!url) continue;
      const title = stripTopvisorHtml(typeof record.snippet_title === "string" ? record.snippet_title : "");
      const snippet = stripTopvisorHtml(typeof record.snippet_body === "string" ? record.snippet_body : "");
      const domain = (typeof record.domain === "string" && record.domain.trim()) || domainOf(url);
      observations.push({
        kind: "organic",
        surface: "organic",
        region: input.region.region,
        engine: input.region.engine,
        query: ourQuery,
        url,
        title: title || undefined,
        snippet: snippet || undefined,
        rank: parsed.rank,
        provider: topvisorProviderName(input.region.engine),
        providerTaskId: input.provenance.providerTaskId,
        externalTaskId: input.provenance.externalTaskId,
        tool: "positions",
        caseAgent: "TOPVISOR_POSITIONS",
        enrichmentRunId: input.provenance.enrichmentRunId,
        unifiedJobId: input.provenance.unifiedJobId,
        sourceUrlOrQuery: ourQuery,
        sourceIndex: parsed.rank,
        collectedAt: parsed.date,
        clientEvidence: true,
        resultHash: createHash("sha256")
          .update(
            [input.provenance.externalTaskId ?? "", input.region.key, name, String(parsed.rank), url, domain ?? ""].join("|")
          )
          .digest("hex"),
      });
    }
  }
  if (mismatched > 0) {
    warnings.push(`region-index-mismatch:${input.region.key}:expected=${input.regionIndex}:rows=${mismatched}`);
  }
  return { observations, matchedKeywords, unmatchedKeywords, warnings };
}

/** Процент выполнения проверки из ответа `get/projects_2/projects`. */
export function readCheckPercent(body: unknown): number | null {
  const rows = (body as { result?: unknown } | null)?.result;
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return null;
  const percent = Number(row.status_positions_percent);
  return Number.isFinite(percent) ? percent : null;
}

/**
 * Применены ли настройки проекта — по чтению, а не по ответу на запись.
 *
 * `edit/positions_2/settings` принимает несуществующие поля молча: на пилоте
 * выдуманное `ai_snippets` стоило одной оплаченной проверки без сниппетов.
 */
export function projectSettingsApplied(
  body: unknown,
  expected: Record<string, number>
): { ok: boolean; missing: string[] } {
  const rows = (body as { result?: unknown } | null)?.result;
  const row = (Array.isArray(rows) ? rows[0] : null) as Record<string, unknown> | null;
  const missing = Object.entries(expected)
    .filter(([key, value]) => Number(row?.[key]) !== value)
    .map(([key]) => key);
  return { ok: missing.length === 0, missing };
}

/** Формы запросов — названы сервисом на пилоте. */
export function projectFilter(projectId: number): Record<string, unknown> {
  return { filters: [{ name: "id", operator: "EQUALS", values: [String(projectId)] }] };
}

export function positionsCheckPayload(projectId: number): Record<string, unknown> {
  return { project_id: projectId, ...projectFilter(projectId) };
}

export function checkStatusPayload(projectId: number): Record<string, unknown> {
  return {
    ...projectFilter(projectId),
    fields: ["id", "status_positions", "status_positions_percent", "status_positions_date"],
  };
}

export function snapshotHistoryPayload(
  projectId: number,
  region: TopvisorAuditRegion,
  date: string,
  depth: number
): Record<string, unknown> {
  return {
    project_id: projectId,
    date1: date,
    date2: date,
    searcher_key: region.searcher_key,
    region_key: region.region_key,
    region_lang: region.region_lang,
    region_device: region.region_device,
    depth_positions: depth,
    history_fields: ["url", "domain", "snippet_title", "snippet_body", "snippet_ext"],
  };
}
