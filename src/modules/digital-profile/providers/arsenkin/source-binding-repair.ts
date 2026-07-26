/**
 * Canonical base ORION source resolution + First36 Full source-binding repair.
 * Never treat effectiveReportRunId / Arsenkin enrichment runs as base source.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { loadArsenkinReportBinding } from "../../orion-golden/classic/arsenkin-report-binding";
import {
  caseScopedArtifactRoot,
  ORION_GOLDEN_QA_STORAGE_ROOT,
} from "../../orion-golden/evidence/admin-review-decision-store";
import {
  loadOrchestrationJob,
  patchOrchestrationJob,
} from "./full-audit-job-store";
import { writeJsonAtomic } from "./arsenkin-db-readiness";

export type SourceBindingRepairReason =
  | "EFFECTIVE_PROVIDER_RUN_USED_AS_BASE_SOURCE"
  | "ARSENKIN_RUN_USED_AS_BASE_SOURCE"
  | "MAPPING_SOURCE_ARSENKIN_PREFIX"
  | "ALREADY_CANONICAL";

export type CanonicalBaseResolveResult =
  | {
      ok: true;
      baseOrionReportRunId: string;
      via:
        | "binding.sourceReportRunId"
        | "mapping.baseOrionReportRunId"
        | "mapping.sourceReportRunId"
        | "latest_non_arsenkin_orion_run";
    }
  | {
      ok: false;
      code: "NEEDS_ADMIN" | "BASE_SOURCE_NOT_FOUND";
      detail: string;
      candidates: string[];
    };

export type SourceBindingRepairArtifact = {
  caseId: string;
  workflow: "FIRST36_FULL";
  reportRunId: string;
  previousSourceReportRunId: string;
  canonicalSourceReportRunId: string;
  reason: SourceBindingRepairReason;
  repaired: boolean;
  repairedAt: string;
  idempotentNoOp?: boolean;
};

export type SourceBindingRepairResult =
  | {
      ok: true;
      repaired: boolean;
      artifact: SourceBindingRepairArtifact;
      baseOrionReportRunId: string;
      enrichmentReportRunId: string;
      previousEnrichmentReportRunId: string | null;
    }
  | {
      ok: false;
      code: "NEEDS_ADMIN" | "BASE_SOURCE_NOT_FOUND" | "NOT_FIRST36_FULL";
      detail: string;
    };

type UiRunMapping = {
  caseId: string;
  sourceReportRunId: string;
  arsenkinReportRunId: string;
  workflow: "suggest-canary" | "first36-full";
  stage: string;
  createdAt: string;
  updatedAt: string;
  baseOrionReportRunId?: string;
};

function caseRoot(caseId: string): string {
  return caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
}

function mappingPath(caseId: string, workflow: "suggest-canary" | "first36-full"): string {
  return join(caseRoot(caseId), `arsenkin-ui-run-mapping-${workflow}.json`);
}

function loadMapping(
  caseId: string,
  workflow: "suggest-canary" | "first36-full"
): UiRunMapping | null {
  const path = mappingPath(caseId, workflow);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as UiRunMapping;
  } catch {
    return null;
  }
}

function saveMapping(mapping: UiRunMapping): void {
  writeJsonAtomic(mappingPath(mapping.caseId, mapping.workflow), mapping);
}

function enrichmentOutRoot(caseId: string, reportRunId: string): string {
  return join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
}

/** Provider/enrichment run ids are never a valid base ORION source. */
export function isArsenkinProviderRunId(reportRunId: string | null | undefined): boolean {
  return String(reportRunId ?? "").trim().startsWith("orion-arsenkin-");
}

export function isValidBaseOrionReportRunId(reportRunId: string | null | undefined): boolean {
  const id = String(reportRunId ?? "").trim();
  if (!id) return false;
  return !isArsenkinProviderRunId(id);
}

export function sourceBindingRepairArtifactPath(caseId: string, enrichmentReportRunId: string): string {
  return join(enrichmentOutRoot(caseId, enrichmentReportRunId), "source-binding-repair.json");
}

function writeRepairArtifact(artifact: SourceBindingRepairArtifact): void {
  const path = sourceBindingRepairArtifactPath(artifact.caseId, artifact.reportRunId);
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomic(path, artifact);
}

function readRepairArtifact(
  caseId: string,
  enrichmentReportRunId: string
): SourceBindingRepairArtifact | null {
  const path = sourceBindingRepairArtifactPath(caseId, enrichmentReportRunId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SourceBindingRepairArtifact;
  } catch {
    return null;
  }
}

/**
 * Resolve the canonical pre-Arsenkin ORION report run for a case.
 * Never returns effectiveReportRunId or any orion-arsenkin-* id.
 */
export async function resolveCanonicalBaseOrionReportRunId(
  caseId: string,
  deps: {
    prisma?: PrismaClient;
    listOrionRunIds?: () => Promise<string[]>;
  } = {}
): Promise<CanonicalBaseResolveResult> {
  const binding = loadArsenkinReportBinding(caseId);
  const bindingSource = binding?.sourceReportRunId?.trim() || null;
  // Rule: use binding.sourceReportRunId only — never effectiveReportRunId.
  if (bindingSource && isValidBaseOrionReportRunId(bindingSource)) {
    return {
      ok: true,
      baseOrionReportRunId: bindingSource,
      via: "binding.sourceReportRunId",
    };
  }

  const fullMapping = loadMapping(caseId, "first36-full");
  const savedBase = fullMapping?.baseOrionReportRunId?.trim() || null;
  if (savedBase && isValidBaseOrionReportRunId(savedBase)) {
    return {
      ok: true,
      baseOrionReportRunId: savedBase,
      via: "mapping.baseOrionReportRunId",
    };
  }
  if (fullMapping?.sourceReportRunId && isValidBaseOrionReportRunId(fullMapping.sourceReportRunId)) {
    return {
      ok: true,
      baseOrionReportRunId: fullMapping.sourceReportRunId,
      via: "mapping.sourceReportRunId",
    };
  }

  const canaryMapping = loadMapping(caseId, "suggest-canary");
  if (
    canaryMapping?.sourceReportRunId &&
    isValidBaseOrionReportRunId(canaryMapping.sourceReportRunId)
  ) {
    return {
      ok: true,
      baseOrionReportRunId: canaryMapping.sourceReportRunId,
      via: "mapping.sourceReportRunId",
    };
  }

  let runIds: string[] = [];
  if (deps.listOrionRunIds) {
    runIds = await deps.listOrionRunIds();
  } else {
    try {
      const prisma = deps.prisma ?? (await import("@/server/prisma/client")).prisma;
      const rows = await prisma.orionReportRun.findMany({
        where: { caseId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
        take: 50,
      });
      runIds = rows.map((r) => r.id);
    } catch {
      runIds = [];
    }
  }

  const candidates = runIds.filter((id) => isValidBaseOrionReportRunId(id));
  if (candidates.length === 0) {
    return {
      ok: false,
      code: "BASE_SOURCE_NOT_FOUND",
      detail: "No non-Arsenkin ORION report run found for case",
      candidates: [],
    };
  }
  if (candidates.length > 1 && !(bindingSource && isValidBaseOrionReportRunId(bindingSource))) {
    return {
      ok: false,
      code: "NEEDS_ADMIN",
      detail: `Ambiguous base ORION candidates (${candidates.length}); binding.sourceReportRunId required`,
      candidates: candidates.slice(0, 10),
    };
  }
  return {
    ok: true,
    baseOrionReportRunId: candidates[0]!,
    via: "latest_non_arsenkin_orion_run",
  };
}

export function needsSourceBindingRepair(sourceReportRunId: string | null | undefined): boolean {
  return isArsenkinProviderRunId(sourceReportRunId);
}

export function isSourceBindingRepairableError(message: string | null | undefined): boolean {
  const m = String(message ?? "");
  return (
    /уже привязан к source/i.test(m) ||
    /SOURCE_BINDING_REPAIRABLE/i.test(m) ||
    /EFFECTIVE_PROVIDER_RUN_USED_AS_BASE/i.test(m) ||
    /orion-arsenkin-suggest-canary/i.test(m)
  );
}

/**
 * File-level transactional repair of FIRST36_FULL mapping + orchestration job source.
 * Does not change enrichment reportRunId, ProviderTasks, observations, or coverage.
 */
export async function repairFirst36FullSourceBinding(input: {
  caseId: string;
  enrichmentReportRunId: string;
  prisma?: PrismaClient;
  listOrionRunIds?: () => Promise<string[]>;
  now?: () => Date;
}): Promise<SourceBindingRepairResult> {
  const nowIso = (input.now ?? (() => new Date()))().toISOString();
  const enrichmentReportRunId = String(input.enrichmentReportRunId ?? "").trim();
  if (!enrichmentReportRunId.startsWith("orion-arsenkin-first36-full-")) {
    return {
      ok: false,
      code: "NOT_FIRST36_FULL",
      detail: `Not a FIRST36_FULL enrichment run: ${enrichmentReportRunId}`,
    };
  }

  const mapping = loadMapping(input.caseId, "first36-full");
  const previousSource =
    mapping?.sourceReportRunId ??
    loadOrchestrationJob(input.caseId, "first36-full")?.sourceReportRunId ??
    "";

  const resolved = await resolveCanonicalBaseOrionReportRunId(input.caseId, {
    prisma: input.prisma,
    listOrionRunIds: input.listOrionRunIds,
  });
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, detail: resolved.detail };
  }

  const canonical = resolved.baseOrionReportRunId;
  const previousEnrichment =
    loadMapping(input.caseId, "suggest-canary")?.arsenkinReportRunId ??
    (isArsenkinProviderRunId(previousSource) ? previousSource : null);

  if (
    previousSource === canonical &&
    mapping?.arsenkinReportRunId === enrichmentReportRunId &&
    isValidBaseOrionReportRunId(previousSource)
  ) {
    const existing = readRepairArtifact(input.caseId, enrichmentReportRunId);
    if (
      existing?.repaired &&
      existing.canonicalSourceReportRunId === canonical &&
      existing.reportRunId === enrichmentReportRunId
    ) {
      return {
        ok: true,
        repaired: false,
        baseOrionReportRunId: canonical,
        enrichmentReportRunId,
        previousEnrichmentReportRunId: previousEnrichment,
        artifact: { ...existing, idempotentNoOp: true },
      };
    }
    const artifact: SourceBindingRepairArtifact = {
      caseId: input.caseId,
      workflow: "FIRST36_FULL",
      reportRunId: enrichmentReportRunId,
      previousSourceReportRunId: previousSource,
      canonicalSourceReportRunId: canonical,
      reason: "ALREADY_CANONICAL",
      repaired: true,
      repairedAt: existing?.repairedAt ?? nowIso,
      idempotentNoOp: true,
    };
    writeRepairArtifact(artifact);
    return {
      ok: true,
      repaired: false,
      artifact,
      baseOrionReportRunId: canonical,
      enrichmentReportRunId,
      previousEnrichmentReportRunId: previousEnrichment,
    };
  }

  const reason: SourceBindingRepairReason = isArsenkinProviderRunId(previousSource)
    ? previousSource.startsWith("orion-arsenkin-suggest-canary-")
      ? "EFFECTIVE_PROVIDER_RUN_USED_AS_BASE_SOURCE"
      : "ARSENKIN_RUN_USED_AS_BASE_SOURCE"
    : "MAPPING_SOURCE_ARSENKIN_PREFIX";

  const nextMapping: UiRunMapping = {
    caseId: input.caseId,
    sourceReportRunId: canonical,
    baseOrionReportRunId: canonical,
    arsenkinReportRunId: enrichmentReportRunId,
    workflow: "first36-full",
    stage: mapping?.stage ?? "FIRST36_STAGE1",
    createdAt: mapping?.createdAt ?? nowIso,
    updatedAt: nowIso,
  };
  saveMapping(nextMapping);

  const job = loadOrchestrationJob(input.caseId, "first36-full");
  if (
    job &&
    (job.reportRunId === enrichmentReportRunId || job.jobReportRunId === enrichmentReportRunId)
  ) {
    patchOrchestrationJob(input.caseId, "first36-full", {
      sourceReportRunId: canonical,
      sourceOrionReportRunId: canonical,
      currentlyBoundReportRunId: previousEnrichment,
      previousBindingReportRunId: previousEnrichment,
      lastError:
        job.lastError && isSourceBindingRepairableError(job.lastError) ? null : job.lastError,
      lastErrorCode:
        job.lastErrorCode === "SOURCE_BINDING_REPAIRABLE" || job.lastErrorCode === "planning_failed"
          ? null
          : job.lastErrorCode,
    });
  }

  const artifact: SourceBindingRepairArtifact = {
    caseId: input.caseId,
    workflow: "FIRST36_FULL",
    reportRunId: enrichmentReportRunId,
    previousSourceReportRunId: previousSource,
    canonicalSourceReportRunId: canonical,
    reason: needsSourceBindingRepair(previousSource)
      ? reason
      : "EFFECTIVE_PROVIDER_RUN_USED_AS_BASE_SOURCE",
    repaired: true,
    repairedAt: nowIso,
  };
  writeRepairArtifact(artifact);

  return {
    ok: true,
    repaired: true,
    artifact,
    baseOrionReportRunId: canonical,
    enrichmentReportRunId,
    previousEnrichmentReportRunId: previousEnrichment,
  };
}

export async function ensureFirst36FullCanonicalSource(input: {
  caseId: string;
  enrichmentReportRunId: string;
  prisma?: PrismaClient;
  listOrionRunIds?: () => Promise<string[]>;
  now?: () => Date;
}): Promise<SourceBindingRepairResult> {
  return repairFirst36FullSourceBinding(input);
}
