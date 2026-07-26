/**
 * Reconcile DONE ProviderTasks that have externalTaskId but zero SerpObservations.
 * Safe /get only — never /set. Idempotent observation persist.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArsenkinClient } from "./client";
import { mapPlannedPayload } from "./execute-arsenkin-execution-plan";
import {
  buildPlannedCoverageMatrix,
  persistPlannedCoverageForDoneRequest,
} from "./planned-coverage-matrix";
import {
  classifyMappedArsenkinResult,
  filterPersistableObservations,
  coverageStatusForOutcome,
  okObservationCount,
} from "./parse-result-semantics";
import type { ProviderTaskStore } from "./provider-task-store";
import { redactDeep } from "./redact";
import { upsertSurfaceCollectionCoverage } from "./surface-coverage";
import { appendArsenkinRecoveryDecision } from "./recovery-decisions";
import type { ArsenkinExecutionPlan, ArsenkinExecutionRequest } from "../../orion-golden/classic/arsenkin-execution-plan";
import type { SerpObservationDraft } from "../../serp-observation/types";
import type { ProviderTaskRecord } from "./types";

export type ReconcileDoneTaskResult = {
  providerTaskId: string;
  externalTaskId: string;
  toolName: string;
  outcome: ReturnType<typeof classifyMappedArsenkinResult>;
  observationCount: number;
  artifactPath: string | null;
  error?: string;
};

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function findPlanRequest(
  plan: ArsenkinExecutionPlan | null,
  row: ProviderTaskRecord
): ArsenkinExecutionRequest | null {
  if (!plan) return null;
  return plan.requests.find((r) => r.requestHash === row.requestHash) ?? null;
}

function synthesizeRequestFromTask(row: ProviderTaskRecord): ArsenkinExecutionRequest {
  const data = asObj(row.requestJson.data);
  const queries = Array.isArray(data.queries) ? (data.queries as string[]) : [];
  const se = data.se;
  let engine = "GOOGLE";
  let region: "RU" | "UAE" = "RU";
  if (typeof se === "number") {
    engine = se === 11 || se === 12 ? "GOOGLE" : "YANDEX";
  } else if (Array.isArray(se) && se.length > 1) {
    engine = "MIXED";
  } else if (Array.isArray(se) && se[0]) {
    engine = Number(asObj(se[0]).type) === 11 || Number(asObj(se[0]).type) === 12 ? "GOOGLE" : "YANDEX";
  }
  if (Number(data.region) === 4 || /uae|ae|intl/i.test(String(data.google_from ?? ""))) {
    region = "UAE";
  }
  return {
    tool: row.toolName as ArsenkinExecutionRequest["tool"],
    engine,
    region,
    query: queries[0] ?? null,
    action: "REUSE",
    requestHash: row.requestHash,
    requestJson: {
      tools_name: String(row.requestJson.tools_name ?? row.toolName),
      data,
    },
    estimatedLimits: 0,
    existingTaskId: row.id,
  };
}

export async function listDoneTasksNeedingReconcile(input: {
  store: ProviderTaskStore;
  reportRunId: string;
  /** Observation counts keyed by providerTaskId */
  observationCountByTaskId: Map<string, number>;
  tasks: ProviderTaskRecord[];
}): Promise<ProviderTaskRecord[]> {
  return input.tasks.filter(
    (t) =>
      t.reportRunId === input.reportRunId &&
      t.state === "DONE" &&
      Boolean(t.externalTaskId) &&
      (input.observationCountByTaskId.get(t.id) ?? 0) === 0
  );
}

export async function reconcileDoneTaskZeroObservations(input: {
  client: ArsenkinClient;
  store: ProviderTaskStore;
  outRoot: string;
  caseId: string;
  reportRunId: string;
  providerTaskId: string;
  actorId: string;
  plan: ArsenkinExecutionPlan | null;
  persistObservations: (drafts: SerpObservationDraft[]) => Promise<unknown>;
  /** When false, reuse stored responseJson and skip /get (tests). Default true. */
  refetch?: boolean;
}): Promise<ReconcileDoneTaskResult> {
  const row = await input.store.findById(input.providerTaskId);
  if (!row) throw new Error(`provider-task-not-found:${input.providerTaskId}`);
  if (row.reportRunId !== input.reportRunId) throw new Error("reportRunId-mismatch");
  if (row.state !== "DONE") throw new Error(`expected-DONE:got=${row.state}`);
  if (!row.externalTaskId) throw new Error("missing-externalTaskId");

  const req = findPlanRequest(input.plan, row) ?? synthesizeRequestFromTask(row);
  let payload: Record<string, unknown> | null = row.responseJson;
  let fetchFailed = false;
  let fetchError: string | undefined;

  if (input.refetch !== false) {
    try {
      const got = await input.client.getTask(row.externalTaskId);
      payload = got.raw;
      await input.store.updateState(row.id, {
        state: "DONE",
        responseJson: {
          ...got.raw,
          _reconcile: {
            fetchedAt: new Date().toISOString(),
            priorHadResponse: Boolean(row.responseJson),
          },
        },
      });
    } catch (err) {
      fetchFailed = true;
      fetchError = err instanceof Error ? err.message : String(err);
    }
  }

  mkdirSync(input.outRoot, { recursive: true });
  const artifactPath = join(input.outRoot, `provider-task-${row.id}-result.json`);
  if (payload) {
    writeFileSync(artifactPath, JSON.stringify(redactDeep(payload), null, 2), "utf-8");
  }

  if (fetchFailed || !payload) {
    const outcome = "RESULT_FETCH_FAILED" as const;
    const cov = coverageStatusForOutcome(outcome);
    // Mark coverage cells for this requestHash without claiming success
    if (input.plan) {
      const targets = buildPlannedCoverageMatrix(input.plan).filter(
        (t) => t.requestHash === row.requestHash
      );
      for (const t of targets) {
        await upsertSurfaceCollectionCoverage({
          reportRunId: input.reportRunId,
          provider: "arsenkin",
          tool: t.tool,
          providerTaskId: row.id,
          queryId: t.queryId,
          queryText: t.queryText,
          engine: t.engine,
          region: t.region,
          language: t.language,
          device: t.device,
          surface: t.surface,
          resultCount: 0,
          errorCode: cov.errorCode,
          status: cov.status,
        });
      }
    }
    appendArsenkinRecoveryDecision(input.outRoot, {
      caseId: input.caseId,
      reportRunId: input.reportRunId,
      decision: {
        kind: "RECONCILE_DONE_ZERO_OBS",
        reportRunId: input.reportRunId,
        providerTaskId: row.id,
        requestHash: row.requestHash,
        toolName: row.toolName,
        actorId: input.actorId,
        externalTaskId: row.externalTaskId,
        metadata: { outcome, error: fetchError },
      },
    });
    return {
      providerTaskId: row.id,
      externalTaskId: row.externalTaskId,
      toolName: row.toolName,
      outcome,
      observationCount: 0,
      artifactPath: payload ? artifactPath : null,
      error: fetchError,
    };
  }

  const mapped = mapPlannedPayload({
    req,
    caseId: input.caseId,
    auditRunId: input.reportRunId,
    payload,
  }).map((d) => ({ ...d, providerTaskId: row.id }));

  const outcome = classifyMappedArsenkinResult({
    tool: row.toolName,
    payload,
    drafts: mapped,
  });
  const persistable = filterPersistableObservations(mapped);

  if (persistable.length > 0) {
    await input.persistObservations(persistable);
  }

  const resultCountByQueryId = new Map<string, number>();
  for (const d of persistable) {
    if (d.providerStatus !== "OK") continue;
    resultCountByQueryId.set(d.queryId, (resultCountByQueryId.get(d.queryId) ?? 0) + 1);
  }

  if (input.plan) {
    const targets = buildPlannedCoverageMatrix(input.plan);
    if (outcome === "FAILED_PARSE") {
      for (const t of targets.filter((x) => x.requestHash === row.requestHash)) {
        await upsertSurfaceCollectionCoverage({
          reportRunId: input.reportRunId,
          provider: "arsenkin",
          tool: t.tool,
          providerTaskId: row.id,
          queryId: t.queryId,
          queryText: t.queryText,
          engine: t.engine,
          region: t.region,
          language: t.language,
          device: t.device,
          surface: t.surface,
          resultCount: 0,
          errorCode: "failed_parse",
          status: "FAILED_PARSE",
        });
      }
    } else {
      await persistPlannedCoverageForDoneRequest({
        reportRunId: input.reportRunId,
        requestHash: row.requestHash,
        providerTaskId: row.id,
        targets,
        resultCountByQueryId,
      });
    }
  }

  appendArsenkinRecoveryDecision(input.outRoot, {
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    decision: {
      kind: "RECONCILE_DONE_ZERO_OBS",
      reportRunId: input.reportRunId,
      providerTaskId: row.id,
      requestHash: row.requestHash,
      toolName: row.toolName,
      actorId: input.actorId,
      externalTaskId: row.externalTaskId,
      metadata: {
        outcome,
        observationCount: okObservationCount(persistable),
        artifactPath,
      },
    },
  });

  return {
    providerTaskId: row.id,
    externalTaskId: row.externalTaskId,
    toolName: row.toolName,
    outcome,
    observationCount: okObservationCount(persistable),
    artifactPath,
  };
}

export async function reconcileAllDoneZeroObservationTasks(input: {
  client: ArsenkinClient;
  store: ProviderTaskStore;
  outRoot: string;
  caseId: string;
  reportRunId: string;
  actorId: string;
  plan: ArsenkinExecutionPlan | null;
  tasks: ProviderTaskRecord[];
  observationCountByTaskId: Map<string, number>;
  persistObservations: (drafts: SerpObservationDraft[]) => Promise<unknown>;
  refetch?: boolean;
}): Promise<ReconcileDoneTaskResult[]> {
  const need = await listDoneTasksNeedingReconcile({
    store: input.store,
    reportRunId: input.reportRunId,
    observationCountByTaskId: input.observationCountByTaskId,
    tasks: input.tasks,
  });
  const out: ReconcileDoneTaskResult[] = [];
  for (const row of need) {
    out.push(
      await reconcileDoneTaskZeroObservations({
        client: input.client,
        store: input.store,
        outRoot: input.outRoot,
        caseId: input.caseId,
        reportRunId: input.reportRunId,
        providerTaskId: row.id,
        actorId: input.actorId,
        plan: input.plan,
        persistObservations: input.persistObservations,
        refetch: input.refetch,
      })
    );
  }
  return out;
}
