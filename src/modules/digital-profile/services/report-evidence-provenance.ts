/**
 * End-to-end evidence provenance: who collected what, and whether it can reach the ORION report.
 * Writes JSON snapshots under storage/digital-profile/report-provenance/{caseId}/.
 * NETWORK_CALLS=0 safe (DB reads only when prisma available).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { writeJsonAtomic } from "../providers/arsenkin/arsenkin-db-readiness";
import {
  loadArsenkinReportBinding,
  resolveEffectiveReportRunIdForCase,
  toCompositeBindingModel,
  type ArsenkinReportBinding,
} from "../orion-golden/classic/arsenkin-report-binding";
import { listRunningArsenkinCaseAgentExecutions, loadArsenkinCaseAgentExecution } from "./arsenkin-case-agent-execution";

export type ReportProvenancePhase =
  | "AGENT_COLLECT"
  | "ARSENKIN_CASE_AGENT"
  | "ORION_PREPARE"
  | "ORION_REBUILD_CONTENT"
  | "ORION_PDF_RENDER"
  | "DIAGNOSTIC";

export type ReportProvenanceSnapshot = {
  version: "report-evidence-provenance-v1";
  phase: ReportProvenancePhase;
  caseId: string;
  at: string;
  trigger?: string;
  agentRuns: Array<{
    id: string;
    agentName: string;
    status: string;
    itemsSaved: number;
    startedAt: string | null;
    finishedAt: string | null;
    summary: string | null;
    outcome: string | null;
    enrichmentReportRunId: string | null;
  }>;
  searchResultCount: number;
  searchSurfaceItemCount: number;
  serpObservationsByAuditRunId: Array<{
    auditRunId: string;
    count: number;
    providers: string[];
  }>;
  binding: {
    exists: boolean;
    status: string | null;
    sourceReportRunId: string | null;
    effectiveReportRunId: string | null;
    enrichmentRunIds: string[];
    workflow: string | null;
  };
  resolvedEffectiveReportRunId: string | null;
  fromArsenkinBinding: boolean;
  caseAgentJobs: Array<{
    executionId: string;
    agentId: string;
    phase: string;
    enrichmentReportRunId: string;
    observationHint: number | null;
  }>;
  gaps: string[];
  notes: string[];
};

function provenanceRoot(caseId: string): string {
  return join(process.cwd(), "storage", "digital-profile", "report-provenance", caseId);
}

export function reportProvenancePath(caseId: string, stamp: string): string {
  return join(provenanceRoot(caseId), `${stamp}.json`);
}

function summarizeOutput(output: unknown): { summary: string | null; outcome: string | null; enrichmentReportRunId: string | null } {
  if (!output || typeof output !== "object") {
    return { summary: null, outcome: null, enrichmentReportRunId: null };
  }
  const o = output as Record<string, unknown>;
  const arsenkin = o.arsenkinExecution as Record<string, unknown> | undefined;
  return {
    summary: typeof o.summary === "string" ? o.summary : null,
    outcome: typeof o.outcome === "string" ? o.outcome : null,
    enrichmentReportRunId:
      typeof arsenkin?.enrichmentReportRunId === "string"
        ? arsenkin.enrichmentReportRunId
        : null,
  };
}

export async function buildReportEvidenceProvenance(input: {
  caseId: string;
  phase: ReportProvenancePhase;
  trigger?: string;
  prisma?: PrismaClient;
}): Promise<ReportProvenanceSnapshot> {
  const at = new Date().toISOString();
  const notes: string[] = [];
  const gaps: string[] = [];

  let searchResultCount = 0;
  let searchSurfaceItemCount = 0;
  const serpObservationsByAuditRunId: ReportProvenanceSnapshot["serpObservationsByAuditRunId"] = [];
  const agentRuns: ReportProvenanceSnapshot["agentRuns"] = [];

  try {
    const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
    const [results, surfaces, obsGroups, runs] = await Promise.all([
      prisma.searchResult.count({ where: { caseId: input.caseId } }),
      prisma.searchSurfaceItem.count({ where: { caseId: input.caseId, deletedAt: null } }),
      prisma.serpObservation.groupBy({
        by: ["auditRunId"],
        where: { caseId: input.caseId },
        _count: { _all: true },
      }),
      prisma.agentRun.findMany({
        where: { caseId: input.caseId },
        orderBy: { startedAt: "desc" },
        take: 40,
        select: {
          id: true,
          agentName: true,
          status: true,
          itemsSaved: true,
          startedAt: true,
          finishedAt: true,
          output: true,
        },
      }),
    ]);
    searchResultCount = results;
    searchSurfaceItemCount = surfaces;

    for (const g of obsGroups) {
      const providers = await prisma.serpObservation.findMany({
        where: { caseId: input.caseId, auditRunId: g.auditRunId },
        distinct: ["provider"],
        select: { provider: true },
        take: 20,
      });
      serpObservationsByAuditRunId.push({
        auditRunId: g.auditRunId,
        count: g._count._all,
        providers: providers.map((p) => p.provider),
      });
    }
    serpObservationsByAuditRunId.sort((a, b) => b.count - a.count);

    for (const r of runs) {
      const s = summarizeOutput(r.output);
      agentRuns.push({
        id: r.id,
        agentName: String(r.agentName),
        status: String(r.status),
        itemsSaved: r.itemsSaved ?? 0,
        startedAt: r.startedAt?.toISOString() ?? null,
        finishedAt: r.finishedAt?.toISOString() ?? null,
        summary: s.summary,
        outcome: s.outcome,
        enrichmentReportRunId: s.enrichmentReportRunId,
      });
    }
  } catch (err) {
    notes.push(`db-read-failed:${err instanceof Error ? err.message : String(err)}`);
  }

  const bindingRaw = loadArsenkinReportBinding(input.caseId);
  let enrichmentRunIds: string[] = [];
  if (bindingRaw) {
    try {
      enrichmentRunIds = toCompositeBindingModel(bindingRaw).enrichmentRuns.map((r) => r.reportRunId);
    } catch {
      enrichmentRunIds = bindingRaw.effectiveReportRunId ? [bindingRaw.effectiveReportRunId] : [];
    }
  }
  const resolved = resolveEffectiveReportRunIdForCase(input.caseId, "");

  const caseAgentJobs: ReportProvenanceSnapshot["caseAgentJobs"] = [];
  try {
    const root = join(process.cwd(), "storage", "digital-profile", "arsenkin-case-agent-runs", input.caseId);
    if (existsSync(root)) {
      for (const f of readdirSync(root)) {
        if (!f.endsWith(".json")) continue;
        const job = loadArsenkinCaseAgentExecution(input.caseId, f.replace(/\.json$/, ""));
        if (!job) continue;
        caseAgentJobs.push({
          executionId: job.executionId,
          agentId: job.agentId,
          phase: job.phase,
          enrichmentReportRunId: job.enrichmentReportRunId,
          observationHint: null,
        });
      }
    }
  } catch {
    /* ignore */
  }
  // Attach live running list too
  for (const j of listRunningArsenkinCaseAgentExecutions(input.caseId)) {
    if (!caseAgentJobs.some((x) => x.executionId === j.executionId)) {
      caseAgentJobs.push({
        executionId: j.executionId,
        agentId: j.agentId,
        phase: j.phase,
        enrichmentReportRunId: j.enrichmentReportRunId,
        observationHint: null,
      });
    }
  }

  const boundSet = new Set(enrichmentRunIds);
  if (resolved.reportRunId) boundSet.add(resolved.reportRunId);

  for (const obs of serpObservationsByAuditRunId) {
    const id = obs.auditRunId;
    if (id.startsWith("orion-arsenkin-agent-") && !boundSet.has(id)) {
      gaps.push(
        `ORPHAN_CASE_AGENT_OBS:${id}:${obs.count} — собрано CaseAgent, но не в arsenkin-report-binding.enrichmentRuns; classic PDF их не мержит`
      );
    }
    if (id.startsWith("orion-arsenkin-suggest-canary-") && obs.count > 0) {
      notes.push(`canary-run-present:${id}:${obs.count}`);
    }
  }

  for (const job of caseAgentJobs) {
    if (
      (job.phase === "FINALIZED" || job.phase === "FAILED") &&
      job.enrichmentReportRunId &&
      !boundSet.has(job.enrichmentReportRunId)
    ) {
      const hasObs = serpObservationsByAuditRunId.some(
        (o) => o.auditRunId === job.enrichmentReportRunId && o.count > 0
      );
      if (hasObs) {
        gaps.push(
          `CASE_AGENT_NOT_BOUND:${job.agentId}:${job.enrichmentReportRunId}`
        );
      }
    }
  }

  if (!bindingRaw) {
    gaps.push("NO_ARSENKIN_REPORT_BINDING — PDF берёт base ORION / SearchResult без Arsenkin overlay");
  } else if (bindingRaw.stage === "SUGGEST_RU_CANARY") {
    notes.push(
      "binding-stage=SUGGEST_RU_CANARY — effective run is canary (autocomplete only); CaseAgent organic/PAA/AI не попадут без enrichmentRuns merge"
    );
  }

  if (searchResultCount === 0 && searchSurfaceItemCount === 0) {
    gaps.push("NO_BASE_SEARCH_EVIDENCE — Yandex/Serper SearchResult/Surface пусты");
  }

  notes.push(
    `phase=${input.phase}`,
    `searchResults=${searchResultCount}`,
    `surfaces=${searchSurfaceItemCount}`,
    `obsRuns=${serpObservationsByAuditRunId.length}`,
    `agentRuns=${agentRuns.length}`,
    `gaps=${gaps.length}`
  );

  return {
    version: "report-evidence-provenance-v1",
    phase: input.phase,
    caseId: input.caseId,
    at,
    trigger: input.trigger,
    agentRuns,
    searchResultCount,
    searchSurfaceItemCount,
    serpObservationsByAuditRunId,
    binding: {
      exists: Boolean(bindingRaw),
      status: bindingRaw?.status ?? null,
      sourceReportRunId: bindingRaw?.sourceReportRunId ?? null,
      effectiveReportRunId: bindingRaw?.effectiveReportRunId ?? null,
      enrichmentRunIds,
      workflow: bindingRaw?.workflow ?? null,
    },
    resolvedEffectiveReportRunId: resolved.reportRunId || null,
    fromArsenkinBinding: resolved.fromArsenkinBinding,
    caseAgentJobs,
    gaps,
    notes,
  };
}

export async function writeReportEvidenceProvenance(input: {
  caseId: string;
  phase: ReportProvenancePhase;
  trigger?: string;
  prisma?: PrismaClient;
}): Promise<{ path: string; snapshot: ReportProvenanceSnapshot }> {
  const snapshot = await buildReportEvidenceProvenance(input);
  const stamp = `${Date.now()}-${input.phase.toLowerCase()}`;
  mkdirSync(provenanceRoot(input.caseId), { recursive: true });
  const path = reportProvenancePath(input.caseId, stamp);
  writeJsonAtomic(path, snapshot);
  console.info(
    JSON.stringify({
      event: "report_evidence_provenance",
      caseId: input.caseId,
      phase: input.phase,
      trigger: input.trigger ?? null,
      path,
      gaps: snapshot.gaps,
      bindingEffective: snapshot.binding.effectiveReportRunId,
      searchResultCount: snapshot.searchResultCount,
      obsByRun: snapshot.serpObservationsByAuditRunId.slice(0, 8),
    })
  );
  return { path, snapshot };
}

/** Latest snapshot for a case (best-effort). */
export function readLatestReportEvidenceProvenance(caseId: string): ReportProvenanceSnapshot | null {
  const root = provenanceRoot(caseId);
  if (!existsSync(root)) return null;
  const files = readdirSync(root)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();
  const first = files[0];
  if (!first) return null;
  try {
    return JSON.parse(readFileSync(join(root, first), "utf-8")) as ReportProvenanceSnapshot;
  } catch {
    return null;
  }
}

export type { ArsenkinReportBinding };
