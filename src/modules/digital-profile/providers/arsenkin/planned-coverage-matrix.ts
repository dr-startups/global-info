/**
 * Planned coverage matrix derived from ArsenkinExecutionPlan (pure + persist helpers).
 */

import type { ArsenkinExecutionPlan, ArsenkinExecutionRequest } from "../../orion-golden/classic/arsenkin-execution-plan";
import { buildSerpQueryId } from "../../serp-observation/query-id";
import { upsertSurfaceCollectionCoverage } from "./surface-coverage";
import { seTypeToEngine } from "./regions";

export type PlannedCoverageTarget = {
  tool: string;
  queryText: string;
  engine: string;
  region: string;
  language: string;
  surface: string;
  device: string;
  queryId: string;
  requestHash: string;
};

export function buildPlannedCoverageMatrix(plan: ArsenkinExecutionPlan): PlannedCoverageTarget[] {
  const out: PlannedCoverageTarget[] = [];
  for (const req of plan.requests) {
    out.push(...targetsForRequest(plan.reportRunId, req));
  }
  // Deterministic order
  return out.sort((a, b) => a.queryId.localeCompare(b.queryId));
}

function targetsForRequest(
  reportRunId: string,
  req: ArsenkinExecutionRequest
): PlannedCoverageTarget[] {
  const region = req.region === "UAE" ? "UAE" : "RU";
  const language = region === "UAE" ? "en" : "ru";
  const device = "DESKTOP";
  const data = req.requestJson.data;

  if (req.tool === "check-top") {
    const queries = Array.isArray(data.queries) ? (data.queries as string[]) : [req.query ?? ""];
    const seList = Array.isArray(data.se) ? (data.se as Array<{ type?: number }>) : [];
    const engines =
      seList.length > 0
        ? [...new Set(seList.map((s) => seTypeToEngine(Number(s.type ?? 0))))]
        : [req.engine ?? "GOOGLE"];
    const targets: PlannedCoverageTarget[] = [];
    for (const queryText of queries.filter(Boolean)) {
      for (const engine of engines) {
        targets.push(
          makeTarget({
            reportRunId,
            tool: "check-top",
            queryText,
            engine,
            region,
            language,
            surface: "organic",
            device,
            requestHash: req.requestHash,
          })
        );
      }
    }
    return targets;
  }

  if (req.tool === "suggest" || req.tool === "paa" || req.tool === "ai-serp") {
    const queries = Array.isArray(data.queries)
      ? (data.queries as string[])
      : [req.query ?? ""].filter(Boolean);
    const surface =
      req.tool === "suggest" ? "autocomplete" : req.tool === "paa" ? "paa" : "ai_answer";
    const engine = req.engine ?? (req.tool === "paa" ? "GOOGLE" : "GOOGLE");
    return queries.map((queryText) =>
      makeTarget({
        reportRunId,
        tool: req.tool,
        queryText,
        engine,
        region,
        language,
        surface,
        device,
        requestHash: req.requestHash,
      })
    );
  }

  if (req.tool === "check-h" || req.tool === "indexation") {
    const urls = Array.isArray(data.urls) ? (data.urls as string[]) : [];
    const surface = req.tool === "check-h" ? "page_meta" : "indexation";
    return urls.map((url) =>
      makeTarget({
        reportRunId,
        tool: req.tool,
        queryText: url,
        engine: "GOOGLE",
        region: "RU",
        language: "ru",
        surface,
        device,
        requestHash: req.requestHash,
      })
    );
  }

  return [];
}

function makeTarget(input: {
  reportRunId: string;
  tool: string;
  queryText: string;
  engine: string;
  region: string;
  language: string;
  surface: string;
  device: string;
  requestHash: string;
}): PlannedCoverageTarget {
  return {
    tool: input.tool,
    queryText: input.queryText,
    engine: input.engine,
    region: input.region,
    language: input.language,
    surface: input.surface,
    device: input.device,
    requestHash: input.requestHash,
    queryId: buildSerpQueryId({
      auditRunId: input.reportRunId,
      provider: "arsenkin",
      engine: input.engine as "GOOGLE" | "YANDEX",
      region: input.region,
      language: input.language,
      queryText: input.queryText,
      surface: input.surface as "organic" | "autocomplete" | "paa" | "ai_answer" | "page_meta" | "indexation",
    }),
  };
}

export type CoveragePersistOutcome = {
  queryId: string;
  status: "OK" | "NO_RESULTS";
  resultCount: number;
  providerTaskId: string;
};

/**
 * Persist planned coverage for a DONE task.
 * Empty successful response → NO_RESULTS (resultCount=0), never for FAILED.
 */
export async function persistPlannedCoverageForDoneRequest(input: {
  reportRunId: string;
  requestHash: string;
  providerTaskId: string;
  targets: PlannedCoverageTarget[];
  /** Counts by queryId from mapped OK drafts; missing → 0 (NO_RESULTS). */
  resultCountByQueryId: Map<string, number>;
}): Promise<CoveragePersistOutcome[]> {
  const matched = input.targets.filter((t) => t.requestHash === input.requestHash);
  const out: CoveragePersistOutcome[] = [];
  for (const t of matched) {
    const resultCount = input.resultCountByQueryId.get(t.queryId) ?? 0;
    const status: "OK" | "NO_RESULTS" = resultCount > 0 ? "OK" : "NO_RESULTS";
    await upsertSurfaceCollectionCoverage({
      reportRunId: input.reportRunId,
      provider: "arsenkin",
      tool: t.tool,
      providerTaskId: input.providerTaskId,
      queryId: t.queryId,
      queryText: t.queryText,
      engine: t.engine,
      region: t.region,
      language: t.language,
      device: t.device,
      surface: t.surface,
      resultCount,
    });
    out.push({
      queryId: t.queryId,
      status,
      resultCount,
      providerTaskId: input.providerTaskId,
    });
  }
  return out;
}
