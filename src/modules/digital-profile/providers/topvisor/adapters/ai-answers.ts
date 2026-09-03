/**
 * AI-ответы поисковиков из истории позиций Topvisor.
 *
 * Пилот T0 выяснил: полей `sf_ai_oveview_*`, которых ждал план, не существует.
 * Ответ приходит внутри `serp_features` ответа `get/positions_2/history`
 * объектом `aiOverview {snippetTitle, snippetBody, links[]}` — и Алиса Яндекса
 * пишется туда же, что и Google AI Overview. Условие — настройка проекта
 * `with_ai_overview_full` и `show_serp_features: 1` в запросе.
 *
 * Читается **полный** ответ, а не `aiOverviewPreview`: превью — те же поля,
 * обрезанные до пары предложений, и платили мы именно за полный.
 *
 * Тело ответа и его источники — разные строки наблюдений, и это не украшение:
 * дека печатает тело как текст с подписью «чей это ответ», а ссылки — строками
 * «Источник: …», различая их по наличию публичного адреса
 * (`isAnswerBody`/`isSourceRef` в построителе `knowledge-ai`). Ответ без единой
 * ссылки в отчёт не идёт вовсе: утверждение, которое некуда проследить, —
 * ровно то, что правила продукта запрещают.
 */

import { createHash } from "node:crypto";
import { topvisorProviderName, type TopvisorAuditRegion } from "../regions";
import {
  normalizeKeyword,
  parsePositionsKey,
  stripTopvisorHtml,
  type SnapshotProvenance,
  type TopvisorObservation,
} from "./positions";

/** Заголовка у AI-ответа обычно нет — тогда называем вид, а не выдумываем тему. */
const ANSWER_TITLE_FALLBACK = "Ответ поискового ИИ";

type AiOverview = { snippetTitle?: unknown; snippetBody?: unknown; links?: unknown };

type PositionsBody = {
  result?: {
    keywords?: Array<{ name?: unknown; positionsData?: Record<string, { serp_features?: unknown }> }>;
  } | null;
};

/** `serp_features` приходит строкой JSON (или `[]`, когда блоков нет). */
function parseSerpFeatures(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "object") return Array.isArray(raw) ? null : (raw as Record<string, unknown>);
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function publicLinks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw
        .map((x) => (typeof x === "string" ? x.trim() : ""))
        .filter((x) => /^https?:\/\//i.test(x))
    ),
  ];
}

export function aiAnswersFromPositions(input: {
  body: unknown;
  region: TopvisorAuditRegion;
  regionIndex: number;
  /** Запросы этого региона в нашем написании. */
  queries: readonly string[];
  provenance: SnapshotProvenance;
}): {
  observations: TopvisorObservation[];
  /** Наши запросы, у которых ответа не оказалось, — это факт, а не молчание. */
  absentQueries: string[];
  unmatchedKeywords: string[];
  warnings: string[];
} {
  const byNormalized = new Map<string, string>();
  for (const q of input.queries) byNormalized.set(normalizeKeyword(q), q);

  const observations: TopvisorObservation[] = [];
  const answered = new Set<string>();
  const unmatchedKeywords: string[] = [];
  const warnings: string[] = [];
  const provider = topvisorProviderName(input.region.engine);

  const keywords = (input.body as PositionsBody | null)?.result?.keywords ?? [];
  for (const kw of keywords) {
    const name = normalizeKeyword(typeof kw.name === "string" ? kw.name : "");
    const ourQuery = byNormalized.get(name);
    if (!ourQuery) {
      if (name) unmatchedKeywords.push(name);
      continue;
    }
    for (const [key, cell] of Object.entries(kw.positionsData ?? {})) {
      const parsed = parsePositionsKey(key);
      if (!parsed || parsed.regionIndex !== input.regionIndex) continue;

      const features = parseSerpFeatures(cell?.serp_features);
      const overview = features?.aiOverview as AiOverview | undefined;
      if (!overview || typeof overview !== "object") continue;

      const body = stripTopvisorHtml(typeof overview.snippetBody === "string" ? overview.snippetBody : "");
      if (!body) continue;
      const links = publicLinks(overview.links);
      if (links.length === 0) {
        // Ответ без источников — утверждение, которое некуда проследить.
        warnings.push(`ai-answer-without-sources:${input.region.key}:${name}`);
        continue;
      }

      const title = stripTopvisorHtml(typeof overview.snippetTitle === "string" ? overview.snippetTitle : "");
      const common = {
        kind: "other" as const,
        surface: "ai_answer",
        region: input.region.region,
        engine: input.region.engine,
        query: ourQuery,
        provider,
        providerTaskId: input.provenance.providerTaskId,
        externalTaskId: input.provenance.externalTaskId,
        tool: "positions",
        caseAgent: "TOPVISOR_POSITIONS",
        enrichmentRunId: input.provenance.enrichmentRunId,
        unifiedJobId: input.provenance.unifiedJobId,
        collectedAt: parsed.date,
        clientEvidence: true,
      };
      const hash = (parts: string[]): string =>
        createHash("sha256")
          .update([input.provenance.externalTaskId ?? "", input.region.key, name, ...parts].join("|"))
          .digest("hex");

      // Тело ответа: без публичного адреса — по нему дека и узнаёт текст ответа.
      observations.push({
        ...common,
        title: title || ANSWER_TITLE_FALLBACK,
        snippet: body,
        sourceUrlOrQuery: ourQuery,
        resultHash: hash(["ai-body"]),
      });
      // Источники: по строке на ссылку, без собственного текста.
      for (const [index, url] of links.entries()) {
        observations.push({
          ...common,
          url,
          title: title || ANSWER_TITLE_FALLBACK,
          sourceUrlOrQuery: url,
          sourceIndex: index + 1,
          resultHash: hash(["ai-source", url]),
        });
      }
      answered.add(ourQuery);
    }
  }

  return {
    observations,
    absentQueries: input.queries.filter((q) => !answered.has(q)),
    unmatchedKeywords,
    warnings,
  };
}
